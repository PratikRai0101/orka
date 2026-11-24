import { execFileSync } from "node:child_process";
import {
  closeSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import zlib from "node:zlib";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  HandoffError,
  decodeLines,
  itemSize,
  readSession,
  safePath,
} from "./core.js";

const FILE_LIMIT = 256_000;
const SKILL_LIMIT = 400_000;
const SESSION_LIMIT = 512_000_000;
const RECENT_SESSIONS = 8;

function expand(path) {
  return path === "~" || path.startsWith("~/")
    ? join(homedir(), path.slice(1))
    : path;
}

export function toolHomes(env = process.env) {
  const pi = expand(env.PI_CODING_AGENT_DIR || "~/.pi/agent");
  return {
    claude: expand(env.CLAUDE_CONFIG_DIR || "~/.claude"),
    codex: expand(env.CODEX_HOME || "~/.codex"),
    pi,
    piSessions: expand(env.PI_CODING_AGENT_SESSION_DIR || join(pi, "sessions")),
    agents: expand("~/.agents"),
  };
}

function attempt(action, fallback) {
  try {
    return action();
  } catch {
    return fallback;
  }
}

const real = (path) => attempt(() => realpathSync(path), resolve(path));
const inside = (path, root) => path === root || path.startsWith(root + sep);

function git(cwd, ...args) {
  return attempt(
    () =>
      execFileSync("git", ["-C", cwd, ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 10_000,
        // Reading status must not write the sender's index.
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
      }).trim(),
    "",
  );
}

/** The checkout, its main repository and every linked worktree. */
export function workspace(directory) {
  const cwd = real(directory);
  const top = git(cwd, "rev-parse", "--show-toplevel");
  if (!top) return { cwd, root: cwd, main: cwd, roots: [cwd], git: false };
  const root = real(top);
  const worktrees = git(cwd, "worktree", "list", "--porcelain")
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => real(line.slice(9)));
  return {
    cwd,
    root,
    main: worktrees[0] ?? root,
    roots: [...new Set([root, ...worktrees])],
    git: true,
  };
}

/** Never includes a remote's host, user or credentials. */
export function repository(space) {
  if (!space.git) return undefined;
  const remote = git(space.root, "remote", "get-url", "origin")
    .replace(/\/+$/, "")
    .replace(/\.git$/, "");
  const name =
    /^(?:[a-z+]+:\/\/|[^/]+@)/i.test(remote) &&
    remote.match(/[:/]([^/:@]+\/[^/:@]+)$/)?.[1];
  const branch = git(space.root, "branch", "--show-current");
  const commit = git(space.root, "rev-parse", "HEAD");
  return {
    name: name || basename(space.main),
    ...(branch ? { branch } : {}),
    ...(/^[0-9a-f]{40,64}$/.test(commit) ? { commit } : {}),
    uncommitted: Boolean(git(space.root, "status", "--porcelain")),
  };
}

/** Codex compresses rollouts it hasn’t used for a while. */
function decompress(raw) {
  if (!zlib.zstdDecompressSync)
    throw new HandoffError(
      "This session is compressed. Use Node 22.15 or newer to share it.",
    );
  return zlib.zstdDecompressSync(raw, { maxOutputLength: SESSION_LIMIT });
}

function readSessionBytes(path) {
  if (statSync(path).size > SESSION_LIMIT)
    throw new HandoffError(`${basename(path)} is too large to share.`);
  const raw = readFileSync(path);
  return path.endsWith(".zst") ? decompress(raw) : raw;
}

function firstLines(path, limit = 1_000_000) {
  if (path.endsWith(".zst"))
    return [readSessionBytes(path).toString("utf8").split("\n", 1)[0]];
  const file = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(limit);
    const length = readSync(file, buffer, 0, limit, 0);
    const text = buffer.toString("utf8", 0, length);
    const end = text.lastIndexOf("\n");
    return text.slice(0, end < 0 ? text.length : end).split("\n");
  } finally {
    closeSync(file);
  }
}

function header(path, tool) {
  return attempt(() => {
    for (const line of firstLines(
      path,
      tool === "claude" ? 262_144 : 1_000_000,
    )) {
      const record = attempt(() => JSON.parse(line));
      if (tool === "claude") {
        if (
          typeof record?.cwd === "string" &&
          typeof record.sessionId === "string"
        )
          return { id: record.sessionId, cwd: record.cwd };
        continue;
      }
      const meta = tool === "codex" ? record?.payload : record;
      if (
        record?.type !== (tool === "codex" ? "session_meta" : "session") ||
        typeof meta?.cwd !== "string" ||
        meta.source?.subagent
      )
        return undefined;
      return { id: meta.id, cwd: meta.cwd };
    }
  });
}

function jsonlFiles(directory) {
  return attempt(
    () => readdirSync(directory, { recursive: true, withFileTypes: true }),
    [],
  )
    .filter((entry) => entry.isFile() && /\.jsonl(?:\.zst)?$/.test(entry.name))
    .map((entry) => join(entry.parentPath ?? entry.path, entry.name));
}

function sessionFiles(homes) {
  // Claude keeps subagent transcripts below each session's own directory.
  const claude = attempt(
    () => readdirSync(join(homes.claude, "projects"), { withFileTypes: true }),
    [],
  )
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const directory = join(homes.claude, "projects", entry.name);
      return attempt(() => readdirSync(directory), [])
        .filter((name) => name.endsWith(".jsonl"))
        .map((name) => join(directory, name));
    });
  const all = [
    ...claude.map((path) => ({ tool: "claude", path })),
    ...["sessions", "archived_sessions"]
      .flatMap((name) => jsonlFiles(join(homes.codex, name)))
      .map((path) => ({ tool: "codex", path })),
    ...jsonlFiles(homes.piSessions).map((path) => ({ tool: "pi", path })),
  ];
  return all
    .flatMap((file) => {
      const stat = attempt(() => statSync(file.path));
      return stat?.size
        ? [{ ...file, size: stat.size, modified: stat.mtimeMs }]
        : [];
    })
    .sort((a, b) => b.modified - a.modified);
}

/** Sessions started in this checkout or its linked worktrees, newest first. */
export function listSessions(space, homes) {
  return sessionFiles(homes).flatMap((file) => {
    const meta = header(file.path, file.tool);
    if (!meta) return [];
    const cwd = real(meta.cwd);
    return space.roots.some((root) => inside(cwd, root))
      ? [{ ...file, ...meta, cwd }]
      : [];
  });
}

/** A Codex fork keeps its earlier turns in the rollout it was forked from. */
function codexRecords(path, homes, end, depth = 0) {
  const records = decodeLines(
    readSessionBytes(path).subarray(0, end).toString("utf8"),
  );
  const base = records[0]?.payload?.history_base;
  if (!base) return records;
  const parent = ["sessions", "archived_sessions"]
    .flatMap((name) => jsonlFiles(join(homes.codex, name)))
    .find((file) =>
      [".jsonl", ".jsonl.zst"].some((suffix) =>
        file.endsWith(base.thread_id + suffix),
      ),
    );
  if (!parent || depth >= 20 || !Number.isSafeInteger(base.end_byte_offset))
    throw new HandoffError(
      "Part of this Codex session’s history is missing on this computer.",
    );
  return [
    ...codexRecords(parent, homes, base.end_byte_offset, depth + 1),
    ...records,
  ];
}

export function openSession(path, homes) {
  const records = codexRecords(path, homes);
  // The newest rollout owns the identity. Earlier ones only add history.
  const session = readSession(records);
  const own = header(path, session.tool);
  return { ...session, ...(own ? { id: own.id, cwd: own.cwd } : {}), path };
}

/** An explicit session, the agent running this command, or the newest session here. */
export function chooseSession(
  space,
  homes,
  { session, env = process.env } = {},
) {
  if (session) {
    const path = resolve(expand(session));
    if (attempt(() => statSync(path).isFile())) return path;
    const match = sessionFiles(homes).find((file) =>
      basename(file.path).includes(session),
    );
    if (match && /^[0-9a-f-]{8,}$/i.test(session)) return match.path;
    throw new HandoffError("That session wasn’t found.");
  }
  const running = env.CLAUDE_CODE_SESSION_ID || env.CODEX_THREAD_ID;
  if (running && /^[0-9a-f-]{36}$/i.test(running)) {
    const match = sessionFiles(homes).find((file) =>
      basename(file.path).includes(running),
    );
    if (match) return match.path;
  }
  const sessions = listSessions(space, homes);
  const here =
    sessions.find((item) => inside(item.cwd, space.root)) ?? sessions[0];
  if (here) return here.path;
  throw new HandoffError(
    "No Claude Code, Codex or Pi session was found for this folder. Run this command in your project folder, or pass --session with a file.",
  );
}

/** Reads one regular text file. Symlinks, binaries and environment files stay out. */
function textFile(path, name = basename(path)) {
  return attempt(() => {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size > FILE_LIMIT || !safePath(name))
      return undefined;
    const raw = readFileSync(path);
    if (raw.includes(0)) return undefined;
    const text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
    return text.trim() ? { path: name, text } : undefined;
  });
}

function memoryItems(space, homes, tool) {
  const items = [];
  const add = (path, title, selected) => {
    const file = textFile(path);
    if (file) items.push({ kind: "memory", title, files: [file], selected });
  };
  const folders = [...new Set([space.root, space.cwd])];
  for (const folder of folders)
    for (const name of [
      "CLAUDE.md",
      ".claude/CLAUDE.md",
      "AGENTS.md",
      "AGENTS.override.md",
      "CLAUDE.local.md",
    ]) {
      const path = join(folder, name);
      add(path, relative(space.root, path), !name.includes(".local."));
    }
  const slug = (path) => path.replace(/[^a-zA-Z0-9]/g, "-");
  const projects = [...new Set([space.main, space.root, space.cwd])];
  for (const project of projects) {
    const directory = join(homes.claude, "projects", slug(project), "memory");
    for (const name of attempt(() => readdirSync(directory), [])
      .filter((file) => file.endsWith(".md"))
      .sort()) {
      const file = textFile(join(directory, name));
      if (!file) continue;
      const type = file.text.match(/^\s*type:\s*(\w+)/m)?.[1];
      // Notes about the person, and the index that lists them, need a deliberate choice.
      const selected =
        tool === "claude" &&
        name !== "MEMORY.md" &&
        !["user", "feedback"].includes(type);
      items.push({
        kind: "memory",
        title: `Memory: ${name}`,
        files: [file],
        selected,
      });
    }
  }
  add(join(homes.claude, "CLAUDE.md"), "Personal CLAUDE.md", false);
  add(join(homes.codex, "AGENTS.md"), "Personal Codex AGENTS.md", false);
  add(join(homes.pi, "AGENTS.md"), "Personal Pi AGENTS.md", false);
  return items;
}

function skillFolder(folder) {
  const files = [];
  let total = 0;
  const visit = (directory, prefix) => {
    const entries = attempt(
      () => readdirSync(directory, { withFileTypes: true }),
      [],
    );
    entries.sort(
      (a, b) =>
        (b.name === "SKILL.md") - (a.name === "SKILL.md") ||
        a.name.localeCompare(b.name),
    );
    for (const entry of entries) {
      if (
        entry.name.startsWith(".") ||
        ["node_modules", "dist"].includes(entry.name)
      )
        continue;
      const name = prefix + entry.name;
      if (entry.isDirectory()) visit(join(directory, entry.name), `${name}/`);
      else if (entry.isFile() && files.length < 60) {
        const file = textFile(join(directory, entry.name), name);
        if (!file || total + file.text.length > SKILL_LIMIT) continue;
        total += file.text.length;
        files.push(file);
      }
    }
  };
  visit(folder, "");
  return files;
}

function skillItems(session, space, homes) {
  const projectRoots = [space.root, space.cwd].flatMap((root) =>
    [".claude/skills", ".codex/skills", ".agents/skills", ".pi/skills"].map(
      (path) => join(root, path),
    ),
  );
  const personalRoots = [homes.claude, homes.codex, homes.agents, homes.pi].map(
    (home) => join(home, "skills"),
  );
  const found = new Map();
  const add = (folder, selected) => {
    const path = real(folder);
    if (!attempt(() => lstatSync(join(path, "SKILL.md")).isFile())) return;
    const bundled = /[\\/](?:plugins|\.system|vendor_imports)[\\/]/.test(path);
    const previous = found.get(path);
    found.set(path, {
      path,
      selected: Boolean(previous?.selected || (selected && !bundled)),
    });
  };
  for (const root of new Set(projectRoots))
    for (const name of attempt(() => readdirSync(root), []))
      add(join(root, name), false);
  for (const name of session.skills.names) {
    const short = name.split(":").at(-1);
    if (safePath(short) && !short.includes("/"))
      for (const root of [...projectRoots, ...personalRoots])
        add(join(root, short), true);
  }
  // A transcript can name any path, so accept only the known skill folders.
  const allowed = [
    space.root,
    homes.claude,
    homes.codex,
    homes.agents,
    homes.pi,
  ].map(real);
  for (const raw of session.skills.folders) {
    const value = expand(raw.replace(/^\$\{?HOME\}?/, "~"));
    const folder = real(
      isAbsolute(value) ? value : join(session.cwd ?? space.cwd, value),
    );
    if (
      /[\\/]skills[\\/]/.test(folder) &&
      allowed.some((root) => inside(folder, root))
    )
      add(folder, true);
  }
  return [...found.values()].flatMap(({ path, selected }) => {
    const files = skillFolder(path);
    return files.some((file) => file.path === "SKILL.md")
      ? [{ kind: "skill", title: basename(path), files, selected }]
      : [];
  });
}

function planItems(session, space, homes, transcript) {
  const items = session.plan
    ? [
        {
          kind: "plan",
          title: "Approved plan",
          files: [{ path: "plan.md", text: session.plan }],
          selected: true,
        },
      ]
    : [];
  const projectFolders = [".claude/plans", ".codex/plans"].map((path) =>
    join(space.root, path),
  );
  const personal = [homes.claude, homes.codex].map((home) =>
    join(home, "plans"),
  );
  for (const folder of [...projectFolders, ...personal])
    for (const name of attempt(() => readdirSync(folder), []).filter((file) =>
      file.endsWith(".md"),
    )) {
      const mentioned = transcript.includes(`plans/${name}`);
      // Personal plan folders mix every project, so only offer ones this session used.
      if (!mentioned && personal.includes(folder)) continue;
      const file = textFile(join(folder, name));
      if (file && file.text.trim() !== session.plan?.trim())
        items.push({
          kind: "plan",
          title: name,
          files: [file],
          selected: mentioned,
        });
    }
  return items;
}

function sessionItems(session, space, homes) {
  const others = listSessions(space, homes).filter(
    (item) => item.path !== session.path && item.id !== session.id,
  );
  const mentioned = others
    .filter((item) => session.mentions.includes(item.id))
    .slice(0, 3);
  const recent = others
    .filter((item) => !mentioned.includes(item))
    .slice(0, RECENT_SESSIONS);
  return [...mentioned, ...recent].flatMap((item) => {
    const other = attempt(() => openSession(item.path, homes));
    return other
      ? [
          {
            kind: "session",
            title: other.title,
            tool: other.tool,
            messages: other.messages,
            selected: mentioned.includes(item),
          },
        ]
      : [];
  });
}

/** Everything a sender may attach. Only related, non-personal items start selected. */
export function collectContext(session, space, homes) {
  const transcript = readSessionBytes(session.path).toString("utf8");
  const items = [
    ...memoryItems(space, homes, session.tool),
    ...skillItems(session, space, homes),
    ...planItems(session, space, homes, transcript),
    ...sessionItems(session, space, homes),
  ];
  const seen = new Set();
  return items
    .filter((item) => {
      const key = JSON.stringify([item.kind, item.files ?? item.messages]);
      return !seen.has(key) && seen.add(key);
    })
    .map((item) => ({ ...item, size: itemSize(item) }));
}

export function sessionWorkspace(session, fallback) {
  const exists =
    session.cwd && attempt(() => statSync(session.cwd).isDirectory());
  return exists ? workspace(session.cwd) : fallback;
}

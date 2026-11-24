import { execFileSync } from "node:child_process";
import {
  closeSync,
  existsSync,
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
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import {
  HandoffError,
  LIMITS,
  credentialFile,
  decodeLines,
  itemSize,
  readSession,
  safePath,
} from "./core.js";

const FILE_LIMIT = 256_000;
const SKILL_LIMIT = 400_000;
const SESSION_LIMIT = 512_000_000;
// A first message can hold several pasted images before any record names its folder.
const HEADER_LIMIT = 64_000_000;
const RECENT_SESSIONS = 8;
const UUIDS = /[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/gi;

function expand(path) {
  return path === "~" || path.startsWith("~/")
    ? join(homedir(), path.slice(1))
    : path;
}

export function toolHomes(env = process.env) {
  const pi = expand(env.PI_CODING_AGENT_DIR || "~/.pi/agent");
  return {
    user: homedir(),
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

/** Resolves links, including those above a folder that is gone. */
function real(path) {
  const full = resolve(path);
  return (
    attempt(
      () => realpathSync(full),
      full === dirname(full) ? full : undefined,
    ) ?? join(real(dirname(full)), basename(full))
  );
}
const inside = (path, root) => path === root || path.startsWith(root + sep);

// A hook or alias can point these at another repository.
const GIT_LOCATION =
  /^GIT_(?:DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|OBJECT_DIRECTORY|NAMESPACE|PREFIX)$/i;

function runGit(cwd, ...args) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) =>
        !GIT_LOCATION.test(name) &&
        name.toUpperCase() !== "ORKA_HANDOFF_HOST_TOKEN",
    ),
  );
  return execFileSync(
    "git",
    ["-c", "core.fsmonitor=false", "-C", cwd, ...args],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10_000,
      maxBuffer: 64_000_000,
      // Reading status must not write the sender's index.
      env: { ...env, GIT_OPTIONAL_LOCKS: "0" },
    },
  ).trim();
}

const git = (...args) => attempt(() => runGit(...args), "");

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

/** The nearest checkout, found from the path alone so a deleted folder still works. */
function checkout(path) {
  for (let folder = path; ; folder = dirname(folder)) {
    if (existsSync(join(folder, ".git"))) return folder;
    if (folder === dirname(folder)) return undefined;
  }
}

/** A nested repository, or a project below a plain folder, is a different project. */
function belongs(cwd, space) {
  if (cwd === space.cwd) return true;
  // A repository at the home folder would otherwise claim everything below it.
  if (!space.git || inside(real(homedir()), space.root)) return false;
  const root = checkout(cwd);
  return Boolean(root) && space.roots.includes(root);
}

/** `owner/name` or `name`. Never a remote's host, sign-in, query or local path. */
function remoteName(remote) {
  let path;
  if (/^(?:https?|ssh|git):\/\//i.test(remote))
    path = attempt(() => new URL(remote).pathname);
  else path = remote.match(/^[^/:\s]+@[^/:\s]+:(.+)$/)?.[1];
  const name = path
    ?.replace(/\/+$/, "")
    .replace(/\.git$/, "")
    .split("/")
    .filter(Boolean)
    .slice(-2)
    .join("/");
  return name && /^[\w.-]+(?:\/[\w.-]+)?$/.test(name) ? name : undefined;
}

export function repository(space) {
  if (!space.git) return undefined;
  const remote = git(space.root, "remote", "get-url", "origin");
  const name = (remoteName(remote) ?? basename(space.main)).slice(0, 200);
  // The session's own checkout is gone, so this one's state isn't its state.
  if (space.moved) return { name };
  const branch = git(space.root, "branch", "--show-current");
  const commit = git(space.root, "rev-parse", "HEAD");
  return {
    name,
    ...(branch && branch.length <= 255 ? { branch } : {}),
    ...(/^[0-9a-f]{40,64}$/.test(commit) ? { commit } : {}),
    // If status can't be read, warn instead of calling the checkout clean.
    uncommitted: attempt(
      () => Boolean(runGit(space.root, "status", "--porcelain")),
      true,
    ),
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

/** Complete lines from the start of a file, read only as far as they are needed. */
function* leadingLines(path) {
  if (path.endsWith(".zst")) {
    // Only Codex compresses sessions, and its first record is the header.
    yield* readSessionBytes(path).toString("utf8").split("\n", 1);
    return;
  }
  const file = openSync(path, "r");
  try {
    const chunk = Buffer.alloc(65_536);
    let parts = [];
    for (let total = 0; total < HEADER_LIMIT;) {
      const length = readSync(file, chunk, 0, chunk.length, null);
      if (!length) {
        yield Buffer.concat(parts).toString("utf8");
        return;
      }
      total += length;
      let start = 0;
      for (;;) {
        const end = chunk.subarray(0, length).indexOf(10, start);
        if (end < 0) break;
        parts.push(Buffer.from(chunk.subarray(start, end)));
        yield Buffer.concat(parts).toString("utf8");
        parts = [];
        start = end + 1;
      }
      parts.push(Buffer.from(chunk.subarray(start, length)));
    }
  } finally {
    closeSync(file);
  }
}

function header(path, tool) {
  return attempt(() => {
    for (const line of leadingLines(path)) {
      const record = attempt(() => JSON.parse(line));
      if (tool === "claude") {
        if (
          typeof record?.cwd === "string" &&
          typeof record.sessionId === "string"
        )
          return { id: record.sessionId, cwd: record.cwd, ordinal: 0 };
        continue;
      }
      const meta = tool === "codex" ? record?.payload : record;
      if (
        record?.type !== (tool === "codex" ? "session_meta" : "session") ||
        typeof meta?.cwd !== "string" ||
        meta.source?.subagent
      )
        return undefined;
      return { id: meta.id, cwd: meta.cwd, ordinal: record.ordinal ?? 0 };
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
  // Claude keeps subagent transcripts below each session's own directory. Older
  // versions kept them beside it.
  const claude = attempt(
    () => readdirSync(join(homes.claude, "projects"), { withFileTypes: true }),
    [],
  )
    .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
    .flatMap((entry) => {
      const directory = join(homes.claude, "projects", entry.name);
      return attempt(() => readdirSync(directory), [])
        .filter((name) => /^(?!agent-).*\.jsonl$/.test(name))
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
  const found = new Map();
  for (const file of sessionFiles(homes)) {
    const meta = header(file.path, file.tool);
    if (!meta) continue;
    const cwd = real(meta.cwd);
    if (!belongs(cwd, space)) continue;
    // Codex can split one thread into segments. The last one holds the newest turns.
    const key = file.tool === "codex" ? meta.id : real(file.path);
    const previous = found.get(key);
    if (!previous) found.set(key, { ...file, ...meta, cwd });
    else if (meta.ordinal > previous.ordinal)
      found.set(key, {
        ...file,
        ...meta,
        cwd,
        modified: Math.max(file.modified, previous.modified),
      });
  }
  return [...found.values()].sort((a, b) => b.modified - a.modified);
}

const MISSING_HISTORY =
  "Part of this Codex session’s history is missing or doesn’t match on this computer.";

const ordinalAfter = (records) => records.at(-1)?.ordinal + 1;

/** The one segment that ends exactly where this session says it continued. */
function inheritedBytes(base, homes) {
  const { thread_id: id, end_byte_offset: offset } = base;
  const end = base.end_ordinal_exclusive;
  let found;
  if (
    /^[0-9a-f-]{36}$/i.test(id) &&
    Number.isSafeInteger(offset) &&
    offset > 0 &&
    Number.isSafeInteger(end)
  )
    for (const path of ["sessions", "archived_sessions"].flatMap((name) =>
      jsonlFiles(join(homes.codex, name)),
    )) {
      const name = basename(path).replace(/\.zst$/, "");
      if (!name.endsWith(`${id}.jsonl`) && !name.includes(`-${id}_`)) continue;
      const meta = header(path, "codex");
      if (meta?.id !== id || meta.ordinal >= end) continue;
      const bytes = readSessionBytes(path).subarray(0, offset);
      if (bytes.length !== offset || bytes[offset - 1] !== 10) continue;
      const records = attempt(() => decodeLines(bytes.toString("utf8")));
      if (!records || ordinalAfter(records) !== end) continue;
      if (found && !found.equals(bytes))
        throw new HandoffError(MISSING_HISTORY);
      found = bytes;
    }
  if (!found) throw new HandoffError(MISSING_HISTORY);
  return found;
}

/** A Codex fork keeps its earlier turns in the rollouts it continued from. */
function codexRecords(path, homes) {
  let bytes = readSessionBytes(path);
  let records = decodeLines(bytes.toString("utf8"));
  const cwd = records[0]?.payload?.cwd;
  // A removed worktree still belongs to the checkout around it.
  const space =
    typeof cwd === "string"
      ? workspace(existsSync(cwd) ? cwd : (checkout(real(cwd)) ?? cwd))
      : undefined;
  const parts = [records];
  let total = bytes.length;
  for (let base; (base = records[0]?.payload?.history_base);) {
    if (
      parts.length >= 200 ||
      records[0].ordinal !== base.end_ordinal_exclusive
    )
      throw new HandoffError(MISSING_HISTORY);
    bytes = inheritedBytes(base, homes);
    total += bytes.length;
    if (total > SESSION_LIMIT)
      throw new HandoffError(`${basename(path)} is too large to share.`);
    records = decodeLines(bytes.toString("utf8"));
    const folder = records[0]?.payload?.cwd;
    if (
      !space ||
      typeof folder !== "string" ||
      (real(folder) !== real(cwd) && !belongs(real(folder), space))
    )
      throw new HandoffError(
        "This Codex session continues one from another folder, so it wasn’t shared.",
      );
    parts.unshift(records);
  }
  return parts.flat();
}

export function openSession(path, homes) {
  const records = codexRecords(path, homes);
  // The newest rollout owns the identity. Earlier ones only add history.
  const session = readSession(records);
  const own = header(path, session.tool);
  return { ...session, ...(own ? { id: own.id, cwd: own.cwd } : {}), path };
}

/** Finds sessions by ID. A date or other part of a file name is not an ID. */
function sessionById(homes, id) {
  const wanted = id.toLowerCase();
  if (!/^[0-9a-f]{8}[0-9a-f-]*$/.test(wanted)) return undefined;
  const ids = new Set();
  let best;
  for (const file of sessionFiles(homes)) {
    // A Codex segment adds its own ID after the thread it belongs to.
    const own = basename(file.path).match(UUIDS)?.[0].toLowerCase();
    if (!own?.startsWith(wanted)) continue;
    ids.add(own);
    const ordinal =
      file.tool === "codex" ? (header(file.path, "codex")?.ordinal ?? 0) : 0;
    if (!best || ordinal > best.ordinal) best = { path: file.path, ordinal };
  }
  if (ids.size > 1)
    throw new HandoffError(
      "More than one session starts with that ID. Enter more of it.",
    );
  return best?.path;
}

/** Opens an explicit session, the agent running this command, or the newest session here. */
export function chooseSession(
  space,
  homes,
  { session, env = process.env } = {},
) {
  if (session) {
    const path = resolve(expand(session));
    if (attempt(() => statSync(path).isFile())) return openSession(path, homes);
    const match = sessionById(homes, session);
    if (match) return openSession(match, homes);
    throw new HandoffError("That session wasn’t found.");
  }
  const running = [env.CLAUDE_CODE_SESSION_ID, env.CODEX_THREAD_ID].filter(
    Boolean,
  );
  // One agent can start another, and either could be the one meant.
  if (running.length > 1)
    throw new HandoffError(
      "Two agents are running here. Pass --session with the ID of the one to share.",
    );
  if (running.length) {
    const match = sessionById(homes, running[0]);
    if (match) return openSession(match, homes);
    // An unsaved session must not be replaced by a different one.
    throw new HandoffError(
      "The running agent’s session isn’t saved on this computer. Pass --session to share another one.",
    );
  }
  const sessions = listSessions(space, homes);
  // A linked worktree can be inside this checkout without being part of it.
  const here = (item) =>
    item.cwd === space.cwd || checkout(item.cwd) === space.root;
  const own = sessions.filter(here);
  let empty;
  for (const item of own.length ? own : sessions)
    try {
      return openSession(item.path, homes);
    } catch (error) {
      // A session that was cleared before its first request has nothing to share.
      if (!error.empty) throw error;
      empty = error;
    }
  if (empty) throw empty;
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

/** A file reached through a linked folder outside the project is not the project's. */
const ownFile = (path, root) => inside(real(dirname(path)), root);

/** Only notes marked as about the project start selected. */
function projectNote(text) {
  const matter = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? "";
  const types = [
    ...matter.matchAll(
      /(?:^|[{,])[ \t]*["']?type["']?[ \t]*:[ \t]*["']?([\w-]+)/gim,
    ),
  ].map((match) => match[1].toLowerCase());
  return (
    types.length > 0 &&
    types.every((type) => ["project", "reference"].includes(type))
  );
}

function memoryItems(space, homes, tool) {
  const items = [];
  const add = (path, title, selected) => {
    const file = textFile(path);
    if (file) items.push({ kind: "memory", title, files: [file], selected });
  };
  const personal = [homes.claude, homes.codex, homes.pi, homes.agents].map(
    real,
  );
  const user = homes.user && real(homes.user);
  // Instructions in the home folder, or above it, are about the person.
  const shared = !user || !inside(user, space.root);
  const folders = space.missing ? [] : [...new Set([space.root, space.cwd])];
  for (const folder of folders)
    for (const name of [
      "CLAUDE.md",
      ".claude/CLAUDE.md",
      "AGENTS.md",
      "AGENTS.override.md",
      "CLAUDE.local.md",
    ]) {
      const path = join(folder, name);
      if (!ownFile(path, space.root)) continue;
      add(
        path,
        relative(space.root, path),
        shared &&
          !name.includes(".local.") &&
          !personal.some((home) => inside(real(path), home)),
      );
    }
  const slug = (path) => path.replace(/[^a-zA-Z0-9]/g, "-");
  const projects = [...new Set([space.main, space.root, space.cwd])];
  for (const project of projects) {
    const directory = join(homes.claude, "projects", slug(project), "memory");
    for (const name of attempt(() => readdirSync(directory), [])
      .filter((file) => file.endsWith(".md"))
      .sort()) {
      const file = textFile(join(directory, name));
      if (file)
        items.push({
          kind: "memory",
          title: `Memory: ${name}`,
          files: [file],
          selected: tool === "claude" && projectNote(file.text),
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
  let skipped = 0;
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
      if (entry.isDirectory()) {
        visit(join(directory, entry.name), `${name}/`);
        continue;
      }
      const file =
        entry.isFile() && files.length < 60 && !credentialFile(name)
          ? textFile(join(directory, entry.name), name)
          : undefined;
      if (!file || total + file.text.length > SKILL_LIMIT) {
        skipped++;
        continue;
      }
      total += file.text.length;
      files.push(file);
    }
  };
  visit(folder, "");
  return { files, skipped };
}

function skillItems(session, space, homes) {
  const projects = space.missing ? [] : [space.root, space.cwd];
  const projectRoots = projects.flatMap((root) =>
    [".claude/skills", ".codex/skills", ".agents/skills", ".pi/skills"].map(
      (path) => join(root, path),
    ),
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
  // Only Claude records skill names. It prefers a personal skill to a project one,
  // and a name with a prefix belongs to a plugin.
  const named = [
    homes.claude,
    ...projects.map((root) => join(root, ".claude")),
  ];
  for (const name of session.skills.names)
    if (safePath(name) && !/[/:]/.test(name)) {
      const folder = named
        .map((root) => join(root, "skills", name))
        .find((path) => existsSync(join(path, "SKILL.md")));
      if (folder) add(folder, true);
    }
  // A transcript can name any path, so accept only the known skill folders.
  const allowed = [
    ...projects,
    homes.claude,
    homes.codex,
    homes.agents,
    homes.pi,
  ].map(real);
  for (const raw of session.skills.folders) {
    const value = expand(raw.replace(/^\$\{?HOME\}?/, "~"));
    const folder = real(
      isAbsolute(value) ? value : join(session.cwd ?? "", value),
    );
    if (
      /[\\/]skills[\\/]/.test(folder) &&
      allowed.some((root) => inside(folder, root))
    )
      add(folder, true);
  }
  return [...found.values()].flatMap(({ path, selected }) => {
    const { files, skipped } = skillFolder(path);
    return files.some((file) => file.path === "SKILL.md")
      ? [{ kind: "skill", title: basename(path), files, skipped, selected }]
      : [];
  });
}

function planItems(session, space, homes) {
  const items = session.plan
    ? [
        {
          kind: "plan",
          title: "Plan",
          files: [{ path: "plan.md", text: session.plan }],
          selected: true,
        },
      ]
    : [];
  const used = new Set(
    session.plans.map((raw) => {
      const value = expand(raw.replace(/^\$\{?HOME\}?/, "~"));
      return real(isAbsolute(value) ? value : join(session.cwd ?? "", value));
    }),
  );
  const projectFolders = space.missing
    ? []
    : [".claude/plans", ".codex/plans"].map((path) => join(space.root, path));
  const personal = [homes.claude, homes.codex].map((home) =>
    join(home, "plans"),
  );
  for (const folder of [...projectFolders, ...personal])
    for (const name of attempt(() => readdirSync(folder), []).filter((file) =>
      file.endsWith(".md"),
    )) {
      const path = join(folder, name);
      const mentioned = used.has(real(path));
      // Personal plan folders mix every project, so only offer ones this session used.
      if (
        !mentioned &&
        (personal.includes(folder) || !ownFile(path, space.root))
      )
        continue;
      const file = textFile(path);
      if (file && file.text.trim() !== session.plan?.trim())
        items.push({
          kind: "plan",
          title: name,
          files: [file],
          selected:
            mentioned &&
            !session.planRejected &&
            !session.rejectedPlans.includes(file.text.trim()),
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
  const recent = others.filter((item) => !mentioned.includes(item));
  const items = [];
  // Sessions without a conversation don't use up a place.
  for (const item of [...mentioned, ...recent].slice(0, RECENT_SESSIONS * 5)) {
    if (items.length >= mentioned.length + RECENT_SESSIONS) break;
    const other = attempt(() => openSession(item.path, homes));
    if (other)
      items.push({
        kind: "session",
        title: other.title,
        tool: other.tool,
        messages: other.messages,
        selected: mentioned.includes(item),
      });
  }
  return items;
}

/** Everything a sender may attach. Only related, non-personal items start selected. */
export function collectContext(session, space, homes) {
  const items = [
    ...memoryItems(space, homes, session.tool),
    ...skillItems(session, space, homes),
    ...planItems(session, space, homes),
    ...sessionItems(session, space, homes),
  ];
  // The same file can be in more than one folder. Keep one, selected if any was.
  const unique = new Map();
  for (const item of items) {
    const key = JSON.stringify([item.kind, item.files ?? item.messages]);
    const previous = unique.get(key);
    if (previous) previous.selected ||= item.selected;
    else unique.set(key, item);
  }
  // Never start with a selection that is too large to share.
  let room = LIMITS.bytes - itemSize(session.messages) - 100_000;
  let count = 0;
  return [...unique.values()].map((item) => {
    const size = itemSize(item);
    const selected = item.selected && count < LIMITS.items && size <= room;
    if (selected) {
      count++;
      room -= size;
    }
    return { ...item, size, selected };
  });
}

/** The session's own project. A deleted folder must not borrow the current one. */
export function sessionWorkspace(session, fallback) {
  if (!session.cwd) return missing("");
  if (attempt(() => statSync(session.cwd).isDirectory()))
    return withoutWorktree(workspace(session.cwd));
  const cwd = real(session.cwd);
  return belongs(cwd, fallback) ? { ...fallback, moved: true } : missing(cwd);
}

/** A removed worktree can leave its folder behind, inside another checkout. */
function withoutWorktree(space) {
  const path = relative(space.root, space.cwd);
  return /(?:^|[\\/])(?:\.claude[\\/]worktrees|\.worktrees)[\\/]/.test(path)
    ? { ...space, moved: true }
    : space;
}

function missing(cwd) {
  return { cwd, root: cwd, main: cwd, roots: [cwd], git: false, missing: true };
}

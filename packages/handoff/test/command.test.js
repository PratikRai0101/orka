import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import zlib from "node:zlib";
import { apiOrigin } from "../src/api.js";

const COMMAND = fileURLToPath(
  new URL("../bin/orka-handoff.js", import.meta.url),
);
const ID = "22222222-2222-4222-8222-222222222222";
const RELATED = "33333333-3333-4333-8333-333333333333";

function fixture(t) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "orka-handoff-")));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const write = (path, value) => {
    const target = join(home, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, value);
    return target;
  };
  const project = join(home, "project");
  mkdirSync(project);
  const git = (...args) =>
    execFileSync(
      "git",
      [
        "-C",
        project,
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@example.test",
        ...args,
      ],
      { stdio: "pipe" },
    );
  git("init", "-b", "main");
  git(
    "remote",
    "add",
    "origin",
    "https://person:pass@git.example.test/team/repo.git",
  );
  write("project/AGENTS.md", "Project rules");
  git("add", ".");
  git("commit", "-m", "Start");
  const slug = project.replace(/[^a-zA-Z0-9]/g, "-");
  const claude = (id, content, name = id, cwd = project) => {
    const records = content.map(([type, value]) =>
      JSON.stringify({
        type,
        sessionId: id,
        cwd,
        message: { role: type, content: value },
      }),
    );
    return write(
      `.claude/projects/${slug}/${name}.jsonl`,
      records.join("\n") + "\n",
    );
  };
  claude(RELATED, [["user", "Earlier work"]]);
  claude(ID, [
    ["user", `Fix it with ghp_${"c".repeat(36)}`],
    [
      "assistant",
      [
        { type: "text", text: "Done" },
        { type: "tool_use", name: "Skill", input: { skill: "review" } },
        {
          type: "tool_use",
          name: "Bash",
          input: {
            command: `cat ${RELATED} /etc/skills/host/SKILL.md ${home}/elsewhere/skills/private/SKILL.md`,
          },
        },
        { type: "tool_use", name: "ExitPlanMode", input: { plan: "The plan" } },
      ],
    ],
  ]);
  write(".claude/skills/review/SKILL.md", "Review");
  write(".claude/skills/review/.env", "X=1");
  write(".claude/skills/unused/SKILL.md", "Unused");
  write("elsewhere/skills/private/SKILL.md", "Outside");
  write(
    `.claude/projects/${slug}/memory/build.md`,
    "---\nmetadata:\n  type: project\n---\nBuild facts",
  );
  write(
    `.claude/projects/${slug}/memory/person.md`,
    "---\nmetadata:\n  type: user\n---\nAbout me",
  );
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    ORKA_HANDOFF_DEBUG: "1",
  };
  const run = (args, { origin, extra, cwd = project } = {}) =>
    new Promise((resolve) => {
      const child = spawn(
        process.execPath,
        [COMMAND, ...args, ...(origin ? ["--api", origin] : [])],
        { cwd, env: { ...env, ...extra }, stdio: ["ignore", "pipe", "pipe"] },
      );
      let out = "";
      let err = "";
      child.stdout.on("data", (chunk) => (out += chunk));
      child.stderr.on("data", (chunk) => (err += chunk));
      child.on("close", (code) => resolve({ code, out, err }));
    });
  return { home, project, write, git, claude, run };
}

async function service(
  t,
  {
    handoffs = 1,
    hostToken,
    failures = 0,
    cut = 0,
    revoked = true,
    error = "Busy",
  } = {},
) {
  const seen = { creates: [], polls: 0, starts: 0, tokens: [], paths: [] };
  let valid = "orka_handoff_first";
  const server = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = raw ? JSON.parse(raw) : undefined;
    seen.paths.push(request.url);
    const send = (status, value) => {
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(value));
    };
    if (request.url === "/v2/instance")
      return send(200, { handoffs, handoffHost: hostToken ? 1 : undefined });
    if (request.url === "/v2/handoffs/device") {
      seen.starts++;
      return send(200, {
        deviceCode: "device",
        userCode: "BCDF-GHJK",
        verifyUrl:
          "https://dashboard.example.test/handoff/authorize?code=BCDF-GHJK",
        expiresIn: 60,
        interval: 0.01,
      });
    }
    if (request.url === "/v2/handoffs/device/token")
      return send(
        200,
        ++seen.polls % 2
          ? { status: "pending" }
          : {
              status: "approved",
              token: valid,
              expiresAt: new Date(Date.now() + 1e7).toISOString(),
            },
      );
    if (
      request.headers.authorization !== `Bearer ${valid}` &&
      !(hostToken && request.headers.authorization === `Bearer ${hostToken}`)
    )
      return send(401, { error: "Sign in required" });
    if (request.url === "/v2/handoffs" && request.method === "POST") {
      seen.creates.push(body);
      if (seen.creates.length <= failures) return send(503, { error });
      if (seen.creates.length <= cut) {
        response.writeHead(200, { "Content-Length": 500 });
        response.write('{"url":"https');
        return setTimeout(() => response.destroy(), 20);
      }
      return send(200, {
        id: ID,
        url: "https://dashboard.example.test/handoff/abc",
        expiresAt: new Date(Date.now() + 1e7).toISOString(),
      });
    }
    if (request.url === "/v2/handoffs")
      return send(200, {
        items: [
          {
            id: ID,
            title: "Evil\u001b[2Jtitle",
            expiresAt: new Date().toISOString(),
          },
        ],
      });
    if (request.url === "/v2/handoffs/revoke") return send(200, { revoked });
    return send(200, {});
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    seen,
    rotate: () => (valid = "orka_handoff_second"),
  };
}

test("host sharing creates and revokes a link without starting browser sign-in", async (t) => {
  const { run, claude } = fixture(t);
  const hostToken = `orka_handoff_host_${"b".repeat(64)}`;
  claude(ID, [["user", `Session notes: ${hostToken}`]]);
  const { origin, seen } = await service(t, { hostToken });
  const extra = {
    ORKA_HANDOFF_API: origin,
    ORKA_HANDOFF_HOST_TOKEN: hostToken,
  };
  const unspecified = await run(["--host", "--yes"], { extra });
  assert.match(unspecified.err, /Pass --session/);
  const wrongOrigin = await run(["--host", "--session", ID, "--yes"], {
    origin: "http://127.0.0.1:1",
    extra,
  });
  assert.match(wrongOrigin.err, /configured ORKA_HANDOFF_API/);
  assert.deepEqual(seen.paths, []);
  const result = await run(["--host", "--session", ID, "--yes", "--json"], {
    extra,
  });
  assert.equal(result.code, 0, result.err);
  assert.equal(seen.creates[0].messages[0].text, "Session notes: [REDACTED]");
  const revoked = await run(["revoke", JSON.parse(result.out).id, "--host"], {
    extra,
  });
  assert.equal(revoked.code, 0, revoked.err);
  assert.deepEqual(seen.paths, [
    "/v2/instance",
    "/v2/handoffs",
    "/v2/instance",
    "/v2/handoffs/revoke",
  ]);
});

test("sharing signs in once, sends related context and never sends secrets or personal notes", async (t) => {
  const { run, home } = fixture(t);
  const { origin, seen, rotate } = await service(t);
  const first = await run(["--yes", "--json", "--days", "7"], { origin });
  assert.equal(first.code, 0, first.err);
  assert.equal(
    JSON.parse(first.out).url,
    "https://dashboard.example.test/handoff/abc",
  );
  assert.ok(first.err.includes("BCDF-GHJK"));
  const [body] = seen.creates;
  assert.deepEqual(
    body.items.map((item) => [item.kind, item.title]),
    [
      ["memory", "AGENTS.md"],
      ["memory", "Memory: build.md"],
      ["skill", "review"],
      ["plan", "Plan"],
      ["session", "Earlier work"],
    ],
  );
  assert.deepEqual(
    body.items[2].files.map((file) => file.path),
    ["SKILL.md"],
  );
  assert.equal(body.expiresInDays, 7);
  assert.equal(body.repository.name, "team/repo");
  assert.equal(body.repository.uncommitted, false);
  const encoded = JSON.stringify(body);
  for (const hidden of [
    "ghp_",
    "About me",
    "Outside",
    home,
    "pass@",
    "git.example.test",
  ])
    assert.ok(!encoded.includes(hidden), hidden);
  assert.equal(
    statSync(join(home, ".config/orka-handoff/credentials.json")).mode & 0o777,
    0o600,
  );
  assert.equal((await run(["--yes"], { origin })).code, 0);
  assert.equal(seen.starts, 1);
  rotate();
  assert.equal((await run(["--yes"], { origin })).code, 0);
  assert.equal(seen.starts, 2);
});

test("nothing is uploaded without an explicit choice", async (t) => {
  const { run } = fixture(t);
  const { origin, seen } = await service(t);
  assert.equal((await run([], { origin })).code, 2);
  assert.equal((await run(["--preview"], { origin })).code, 0);
  assert.equal((await run(["--yes", "--items", "99"], { origin })).code, 1);
  assert.equal((await run(["--yes", "--days", "0"], { origin })).code, 1);
  assert.deepEqual(seen.paths, []);
  assert.equal((await run(["--yes", "--items", "1"], { origin })).code, 0);
  assert.equal((await run(["--yes", "--no-context"], { origin })).code, 0);
  assert.deepEqual(
    seen.creates.map((body) => body.items.length),
    [1, 0],
  );
});

test("a retried upload keeps its request ID and an older service is refused first", async (t) => {
  const { run } = fixture(t);
  const flaky = await service(t, { failures: 1 });
  assert.equal((await run(["--yes"], { origin: flaky.origin })).code, 0);
  assert.equal(flaky.seen.creates.length, 2);
  assert.equal(
    flaky.seen.creates[0].requestId,
    flaky.seen.creates[1].requestId,
  );
  const older = await service(t, { handoffs: 0 });
  const result = await run(["--yes"], { origin: older.origin });
  assert.equal(result.code, 1);
  assert.ok(result.err.includes("doesn’t support handoffs"));
  assert.deepEqual(older.seen.paths, ["/v2/instance"]);
});

test("linked worktrees share related sessions, and the running agent's session wins", async (t) => {
  const { run, git, home, claude, write } = fixture(t);
  const { origin, seen } = await service(t);
  const linked = join(home, "linked");
  git("worktree", "add", linked, "-b", "feature");
  writeFileSync(join(linked, "AGENTS.md"), "Changed");
  const other = "44444444-4444-4444-8444-444444444444";
  claude(other, [["user", "Newest elsewhere"]], other, join(home, "outside"));
  const mine = write(
    `.codex/sessions/2026/rollout-x-55555555-5555-4555-8555-555555555555.jsonl`,
    [
      {
        type: "session_meta",
        payload: { id: "55555555-5555-4555-8555-555555555555", cwd: linked },
      },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "In the worktree" }],
        },
      },
    ]
      .map((record) => JSON.stringify(record))
      .join("\n") + "\n",
  );
  assert.equal(
    (await run(["--yes", "--no-context"], { origin, cwd: linked })).code,
    0,
  );
  assert.equal(seen.creates.at(-1).title, "In the worktree");
  assert.deepEqual(seen.creates.at(-1).repository, {
    ...seen.creates.at(-1).repository,
    branch: "feature",
    uncommitted: true,
  });
  assert.equal(
    (
      await run(["--yes", "--no-context"], {
        origin,
        cwd: linked,
        extra: { CLAUDE_CODE_SESSION_ID: ID },
      })
    ).code,
    0,
  );
  assert.ok(seen.creates.at(-1).title.startsWith("Fix it with"));
  assert.equal(
    (await run(["--yes", "--no-context", "--session", mine], { origin })).code,
    0,
  );
  assert.equal(seen.creates.at(-1).tool, "codex");
  const preview = await run(["--preview"], { cwd: linked });
  assert.ok(
    preview.err.includes("Earlier work") &&
      !preview.err.includes("Newest elsewhere"),
  );
});

test("a Codex fork includes only the inherited turns, and a missing parent is refused", async (t) => {
  const { run, write, project, home } = fixture(t);
  const { origin, seen } = await service(t);
  const parent = "66666666-6666-4666-8666-666666666666";
  const child = "77777777-7777-4777-8777-777777777777";
  const session = (id, cwd, first, texts, base) =>
    [
      {
        type: "session_meta",
        payload: { id, cwd, ...(base ? { history_base: base } : {}) },
      },
      ...texts.map((text) => ({
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text }],
        },
      })),
    ]
      .map((record, index) =>
        JSON.stringify({ ...record, ordinal: first + index }),
      )
      .join("\n") + "\n";
  const kept = session(parent, project, 0, ["Kept é"]);
  const path = write(
    `.codex/sessions/rollout-${parent}.jsonl`,
    session(parent, project, 0, ["Kept é", "After the fork"]),
  );
  const base = {
    thread_id: parent,
    end_ordinal_exclusive: 2,
    end_byte_offset: Buffer.byteLength(kept),
  };
  const fork = (value, first = value.end_ordinal_exclusive) =>
    write(
      `.codex/sessions/rollout-${child}.jsonl`,
      session(child, project, first, ["Child"], value),
    );
  const texts = async (file) => {
    const result = await run(["--yes", "--no-context", "--session", file], {
      origin,
    });
    assert.equal(result.code, 0, result.err);
    return seen.creates.at(-1).messages.map((message) => message.text);
  };
  const forked = fork(base);
  assert.deepEqual(await texts(forked), ["Kept é", "Child"]);

  // A thread can continue in further segments that share its ID.
  const second = session(parent, project, 2, ["Second"], base);
  const segment = write(
    `.codex/sessions/rollout-${parent}_88888888-8888-4888-8888-888888888888.jsonl`,
    second,
  );
  assert.deepEqual(await texts(parent), ["Kept é", "Second"]);
  fork({
    thread_id: parent,
    end_ordinal_exclusive: 4,
    end_byte_offset: Buffer.byteLength(second),
  });
  assert.deepEqual(await texts(forked), ["Kept é", "Second", "Child"]);
  rmSync(segment);

  // Turns are never dropped or added when a boundary doesn't match.
  for (const change of [
    { end_byte_offset: -5 },
    { end_byte_offset: 3 },
    { end_byte_offset: 1_000_000 },
    { end_ordinal_exclusive: 3 },
  ]) {
    fork({ ...base, ...change });
    const refused = await run(["--yes", "--session", forked], { origin });
    assert.equal(refused.code, 1, JSON.stringify(change));
  }
  fork(base, 7);
  assert.equal((await run(["--yes", "--session", forked])).code, 1);

  fork(base);
  const other = join(home, "other");
  mkdirSync(other);
  write(
    `.codex/sessions/rollout-${parent}.jsonl`,
    session(parent, other, 0, ["Kept é"]),
  );
  const elsewhere = await run(["--yes", "--session", forked], { origin });
  assert.equal(elsewhere.code, 1);

  const count = seen.creates.length;
  rmSync(path);
  const missing = await run(["--yes", "--no-context", "--session", forked], {
    origin,
  });
  assert.equal(missing.code, 1);
  assert.ok(
    missing.err.includes("history is missing") && !missing.err.includes(home),
  );
  assert.equal(seen.creates.length, count);
});

test(
  "compressed Codex sessions are read",
  { skip: !zlib.zstdCompressSync },
  async (t) => {
    const { run, write, project } = fixture(t);
    const { origin, seen } = await service(t);
    const id = "88888888-8888-4888-8888-888888888888";
    const records = [
      { type: "session_meta", payload: { id, cwd: project } },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Compressed" }],
        },
      },
    ];
    write(
      `.codex/sessions/rollout-${id}.jsonl.zst`,
      zlib.zstdCompressSync(
        records.map((record) => JSON.stringify(record)).join("\n") + "\n",
      ),
    );
    assert.equal(
      (await run(["--yes", "--no-context", "--session", id], { origin })).code,
      0,
    );
    assert.equal(seen.creates[0].messages[0].text, "Compressed");
    assert.ok((await run(["--preview"])).err.includes("Compressed"));
  },
);

test("symlinks and binary files stay out of shared skills", async (t) => {
  const { run, home, write } = fixture(t);
  const { origin, seen } = await service(t);
  write(".claude/skills/review/data.bin", Buffer.from([1, 0, 2]));
  symlinkSync(
    write("secret.txt", "outside"),
    join(home, ".claude/skills/review/link.md"),
  );
  assert.equal((await run(["--yes"], { origin })).code, 0);
  const skill = seen.creates[0].items.find((item) => item.kind === "skill");
  assert.deepEqual(
    skill.files.map((file) => file.path),
    ["SKILL.md"],
  );
});

test("list, revoke and sign-out use the saved sign-in and print safe titles", async (t) => {
  const { run, home } = fixture(t);
  const { origin, seen } = await service(t);
  const list = await run(["list"], { origin });
  assert.ok(list.out.includes(ID) && !list.out.includes("\u001b"));
  assert.equal((await run(["revoke", ID], { origin })).code, 0);
  assert.equal((await run(["sign-out"], { origin })).code, 0);
  assert.ok(seen.paths.includes("/v2/handoffs/device/sign-out"));
  assert.equal(
    readFileSync(join(home, ".config/orka-handoff/credentials.json"), "utf8"),
    "{}",
  );
  chmodSync(home, 0o700);
});

test("plain HTTP is only accepted on this computer", () => {
  assert.throws(() => apiOrigin("http://api.example.test"));
  assert.equal(
    apiOrigin("http://127.0.0.1:3000/path"),
    "http://127.0.0.1:3000",
  );
});

const selected = (err) =>
  err
    .split("\n")
    .filter((line) => line.includes("[x]"))
    .map((line) => line.replace(/^\s*\[x\]\s+\d+\s+/, ""));
const has = (err, text) => selected(err).some((line) => line.includes(text));

test("paths printed by tools don't select another project's plans", async (t) => {
  const { run, write, claude, home } = fixture(t);
  write(".claude/plans/client.md", "Client plan");
  write(".claude/plans/mine.md", "My plan");
  const listing = (id, input) =>
    claude(id, [
      ["user", "Look"],
      ["assistant", [{ type: "tool_use", name: "Bash", input }]],
      [
        "user",
        [{ type: "tool_result", content: `${home}/.claude/plans/client.md` }],
      ],
      ["assistant", "Done"],
    ]);
  const file = listing(ID, { command: "ls ~/.claude/plans/*.md" });
  const listed = await run(["--preview", "--session", file]);
  assert.ok(
    !listed.err.includes("client.md") && !listed.err.includes("mine.md"),
  );
  listing(ID, { command: "cat ~/.claude/plans/mine.md" });
  const used = await run(["--preview", "--session", file]);
  assert.ok(has(used.err, "mine.md") && !used.err.includes("client.md"));
});

test("a rejected plan is not shared", async (t) => {
  const { run, claude } = fixture(t);
  const plan = (id, text) => [
    "assistant",
    [{ type: "tool_use", id, name: "ExitPlanMode", input: { plan: text } }],
  ];
  const result = (id, is_error) => [
    "user",
    [{ type: "tool_result", tool_use_id: id, is_error, content: "x" }],
  ];
  const file = claude(ID, [
    ["user", "Plan it"],
    plan("a", "First plan"),
    result("a", false),
    plan("b", "Second plan"),
    result("b", true),
  ]);
  const { out } = await run(["--preview", "--json", "--session", file]);
  assert.equal(
    JSON.parse(out).items.find((item) => item.kind === "plan").files[0].text,
    "First plan",
  );
});

test("only sessions and files from this project are chosen", async (t) => {
  const { run, write, claude, project, home } = fixture(t);
  // A folder above the project is not the project.
  const parent = await run(["--preview"], { cwd: home });
  assert.equal(parent.code, 1);

  // A newer session in a nested repository belongs to that repository.
  const nested = join(project, "vendor/nested");
  mkdirSync(nested, { recursive: true });
  execFileSync("git", ["init", "-q", nested]);
  claude(
    "99999999-9999-4999-8999-999999999999",
    [["user", "Nested work"]],
    undefined,
    nested,
  );
  assert.ok((await run(["--preview"])).err.includes("Fix it"));

  // Instructions in the home folder are personal.
  write(".claude/CLAUDE.md", "Personal rules");
  write("CLAUDE.md", "Home rules");
  const own = claude(
    "aaaaaaaa-9999-4999-8999-999999999999",
    [["user", "Home work"]],
    undefined,
    home,
  );
  const inHome = await run(["--preview", "--session", own], { cwd: home });
  assert.ok(inHome.err.includes("Home work"));
  assert.ok(!has(inHome.err, "CLAUDE.md"), inHome.err);

  // A linked folder can point outside the project.
  write("outside/CLAUDE.md", "Outside rules");
  write("outside/plans/outside.md", "Outside plan");
  symlinkSync(join(home, "outside"), join(project, ".claude"));
  const linked = await run(["--preview"]);
  assert.ok(!linked.err.includes(".claude/CLAUDE.md"));
  assert.ok(!linked.err.includes("outside.md"));
});

test("a home folder kept in Git doesn't claim the projects below it", async (t) => {
  const { run, claude, write, home } = fixture(t);
  execFileSync("git", ["init", "-q", home]);
  write("CLAUDE.md", "Home rules");
  const notes = join(home, "notes");
  mkdirSync(notes);
  claude(
    "bbbbbbbb-9999-4999-8999-999999999999",
    [["user", "Private notes"]],
    undefined,
    notes,
  );
  assert.equal((await run(["--preview"], { cwd: home })).code, 1);
  claude(
    "cccccccc-9999-4999-8999-999999999999",
    [["user", "Home work"]],
    undefined,
    home,
  );
  const { err } = await run(["--preview"], { cwd: home });
  assert.ok(err.includes("Home work") && !has(err, "CLAUDE.md"), err);
});

test("a session whose folder is gone takes no context from the current one", async (t) => {
  const { run, claude, home } = fixture(t);
  const file = claude(
    "dddddddd-9999-4999-8999-999999999999",
    [["user", "Client work"]],
    undefined,
    join(home, "deleted-client"),
  );
  const { out } = await run(["--preview", "--json", "--session", file]);
  const bundle = JSON.parse(out);
  assert.equal(bundle.title, "Client work");
  assert.equal(bundle.repository, undefined);
  assert.deepEqual(bundle.items, []);
});

test("a large first message doesn't hide the newest session", async (t) => {
  const { run, claude } = fixture(t);
  claude("eeeeeeee-9999-4999-8999-999999999999", [
    [
      "user",
      [
        { type: "image", source: { data: "A".repeat(3_000_000) } },
        { type: "text", text: "Newest work" },
      ],
    ],
  ]);
  assert.ok((await run(["--preview"])).err.includes("Newest work"));
});

test("only memories marked as about the project start selected", async (t) => {
  const { run, write, project } = fixture(t);
  const slug = project.replace(/[^a-zA-Z0-9]/g, "-");
  const note = (name, matter) =>
    write(
      `.claude/projects/${slug}/memory/${name}.md`,
      `---\n${matter}\n---\nNote ${name}\n`,
    );
  note("quoted", 'type: "user"');
  note("upper", "type: User");
  note("inline", "metadata: {type: feedback}");
  note("mixed", "type: project\nmetadata:\n  type: user");
  note("untyped", "name: x\n# type: project is in the text");
  note("body", "name: x\n---\ntype: project");
  note("good", 'metadata: { name: x, type: "Project" }');
  note("link", "metadata:\n  node_type: memory\n  type: reference");
  const { err } = await run(["--preview"]);
  assert.deepEqual(
    selected(err)
      .filter((line) => line.includes("Memory:"))
      .map((line) => line.match(/Memory: (\w+)/)[1]),
    ["build", "good", "link"],
  );
});

test("the review shows a skill's files, leaves credentials out and can print everything", async (t) => {
  const { run, write, home } = fixture(t);
  rmSync(join(home, ".claude/skills/review"), { recursive: true });
  write("checkout/SKILL.md", "Review");
  write("checkout/customers.csv", "a,b");
  write("checkout/secrets.md", "How to handle them");
  write("checkout/config/credentials.json", '{"refresh":"abc123"}');
  write("checkout/server.pem", "x");
  symlinkSync(join(home, "checkout"), join(home, ".claude/skills/review"));
  const { err, out } = await run(["--preview", "--json"]);
  assert.ok(
    err.includes("SKILL.md, customers.csv, secrets.md, 2 left out"),
    err,
  );
  const bundle = JSON.parse(out);
  assert.ok(!out.includes("abc123"));
  assert.ok(bundle.items.some((item) => item.kind === "skill"));
  assert.ok(out.includes("How to handle them"));
});

test("defaults never exceed what can be shared", async (t) => {
  const { run, write, claude, project } = fixture(t);
  const slug = project.replace(/[^a-zA-Z0-9]/g, "-");
  for (let index = 0; index < 65; index++)
    write(
      `.claude/projects/${slug}/memory/n${index}.md`,
      `---\ntype: project\n---\nNote ${index}`,
    );
  claude(RELATED, [["user", `Earlier work ${"x".repeat(4_000_000)}`]]);
  const file = claude(ID, [["user", `Carry on from ${RELATED}`]]);
  const result = await run(["--preview", "--json", "--session", file]);
  assert.equal(result.code, 0, result.err);
  assert.equal(JSON.parse(result.out).items.length, 60);
});

test("sessions are found by ID and not by part of a file name", async (t) => {
  const { run, claude } = fixture(t);
  const a = "12345678-1111-4111-8111-111111111111";
  claude(a, [["user", "First"]], `2026-11-24-${a}`);
  claude("12345678-2222-4222-8222-222222222222", [["user", "Second"]]);
  const date = await run(["--preview", "--session", "2026-11-24"]);
  assert.ok(date.err.includes("wasn’t found"));
  const short = await run(["--preview", "--session", "12345678"]);
  assert.ok(short.err.includes("More than one"));
  const exact = await run(["--preview", "--session", a.slice(0, 13)]);
  assert.ok(exact.err.includes("First"));
});

test("a session the person names starts selected, and linked folders are searched", async (t) => {
  const { run, claude, home, project } = fixture(t);
  const slug = project.replace(/[^a-zA-Z0-9]/g, "-");
  const file = claude(ID, [["user", `Carry on from ${RELATED}`]]);
  assert.ok(
    has((await run(["--preview", "--session", file])).err, "Earlier work"),
  );
  const folder = join(home, ".claude/projects", slug);
  renameSync(folder, join(home, "moved"));
  symlinkSync(join(home, "moved"), folder);
  assert.equal((await run(["--preview"])).code, 0);
});

test("a remote's host, query and local path stay out of the repository name", async (t) => {
  const { run, git } = fixture(t);
  for (const [remote, name] of [
    ["https://git.corp.example.test/repo.git", "repo"],
    ["https://u:p@git.example.test/team/repo?access_token=abcd", "team/repo"],
    ["ssh://git@git.example.test:22/team/repo.git/", "team/repo"],
    ["git@git.example.test:group/team/repo.git", "team/repo"],
    ["file:///Users/jane/client/repo.git", "project"],
    ["/Users/jane/client/repo.git", "project"],
    ["git.example.test:team", "project"],
  ]) {
    git("remote", "set-url", "origin", remote);
    const { out } = await run(["--preview", "--json"]);
    assert.equal(JSON.parse(out).repository.name, name, remote);
  }
});

test("an unclear reply is retried and never reported as a link", async (t) => {
  const { run } = fixture(t);
  const once = await service(t, { cut: 1 });
  const ok = await run(["--yes"], { origin: once.origin });
  assert.equal(ok.code, 0, ok.err);
  assert.equal(ok.out, "https://dashboard.example.test/handoff/abc\n");
  assert.equal(once.seen.creates[0].requestId, once.seen.creates[1].requestId);
  const always = await service(t, { cut: 9 });
  const failed = await run(["--yes"], { origin: always.origin });
  assert.equal(failed.code, 1);
  assert.equal(failed.out, "");
  assert.ok(failed.err.includes("may have been created"));
  const blank = await service(t, { failures: 9, error: "" });
  assert.ok(
    (await run(["--yes"], { origin: blank.origin })).err.includes("503"),
  );
  const hostile = await service(t, { failures: 9, error: "x\u001b[2Jy" });
  assert.ok(
    !(await run(["--yes"], { origin: hostile.origin })).err.includes("\u001b"),
  );
});

test("revoke reports a link that was not found, and older services are explained", async (t) => {
  const { run } = fixture(t);
  const { origin } = await service(t, { revoked: false });
  const result = await run(["revoke", ID], { origin });
  assert.equal(result.code, 1);
  assert.ok(!result.err.includes("no longer works"));
  assert.equal((await run(["revoke", ID, RELATED], { origin })).code, 1);
  const older = await service(t, { handoffs: 0 });
  for (const args of [["list"], ["revoke", ID]])
    assert.ok(
      (await run(args, { origin: older.origin })).err.includes(
        "doesn’t support handoffs",
      ),
    );
});

test("a sign-in that can't be saved still shares", async (t) => {
  const { run, write } = fixture(t);
  const { origin, seen } = await service(t);
  write(".config", "not a folder");
  const result = await run(["--yes"], { origin });
  assert.equal(result.code, 0, result.err);
  assert.equal(seen.creates.length, 1);
  assert.equal((await run(["--yes"], { origin: "not an address" })).code, 1);
});

const preview = async (run, args = [], options) => {
  const result = await run(["--preview", "--json", ...args], options);
  assert.equal(result.code, 0, result.err);
  return { ...result, bundle: JSON.parse(result.out) };
};
const named = (bundle, kind) =>
  bundle.items.filter((item) => item.kind === kind);

test("a fork's parent doesn't start selected", async (t) => {
  const { run, write, project } = fixture(t);
  const parent = "66666666-6666-4666-8666-666666666666";
  const child = "77777777-7777-4777-8777-777777777777";
  const session = (id, text, extra) =>
    write(
      `.codex/sessions/rollout-${id}.jsonl`,
      [
        { type: "session_meta", payload: { id, cwd: project, ...extra } },
        {
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text }],
          },
        },
      ]
        .map((record) => JSON.stringify(record))
        .join("\n") + "\n",
    );
  session(parent, "Private turn after the fork");
  const file = session(child, "Child", { forked_from_id: parent });
  const { bundle, err } = await preview(run, ["--session", file]);
  assert.deepEqual(named(bundle, "session"), []);
  assert.match(err, /\[ \] +\d+ +session +Private turn after the fork/);
});

test("a rejected plan is not shared through its file", async (t) => {
  const { run, write, claude, home } = fixture(t);
  const path = join(home, ".claude/plans/cool-plan.md");
  write(".claude/plans/cool-plan.md", "Second plan");
  const call = (id, name, input) => [
    "assistant",
    [{ type: "tool_use", id, name, input }],
  ];
  const result = (id, is_error) => [
    "user",
    [{ type: "tool_result", tool_use_id: id, is_error, content: "x" }],
  ];
  const started = [
    ["user", "Plan it"],
    call("a", "ExitPlanMode", { plan: "First plan" }),
    result("a", false),
    call("w", "Write", { file_path: path, content: "Second plan" }),
  ];
  const texts = async (...records) => {
    const file = claude(ID, [...started, ...records]);
    const { bundle } = await preview(run, ["--session", file]);
    return named(bundle, "plan").map((item) => item.files[0].text);
  };
  const second = call("b", "ExitPlanMode", { plan: "Second plan" });
  assert.deepEqual(await texts(second, result("b", true)), ["First plan"]);
  // Newer versions record no text with the request.
  assert.deepEqual(
    await texts(call("b", "ExitPlanMode", {}), result("b", true)),
    ["First plan"],
  );
  assert.deepEqual(await texts(second, result("b", false)), ["Second plan"]);
  // The rejected file stays out after a different plan is approved.
  assert.deepEqual(
    await texts(
      second,
      result("b", true),
      call("c", "ExitPlanMode", { plan: "Third plan" }),
      result("c", false),
    ),
    ["Third plan"],
  );
});

test("a skill's name selects only the skill Claude used", async (t) => {
  const { run, write, claude, home } = fixture(t);
  for (const folder of [".codex", ".agents", "project/.claude"])
    write(`${folder}/skills/review/SKILL.md`, `From ${folder}`);
  const skills = async (skill) => {
    const file = claude(ID, [
      ["user", "Check it"],
      ["assistant", [{ type: "tool_use", name: "Skill", input: { skill } }]],
    ]);
    const { bundle } = await preview(run, ["--session", file]);
    return named(bundle, "skill").map((item) => item.files[0].text);
  };
  assert.deepEqual(await skills("someplugin:review"), []);
  assert.deepEqual(await skills("review"), ["Review"]);
  rmSync(join(home, ".claude/skills/review"), { recursive: true });
  assert.deepEqual(await skills("review"), ["From project/.claude"]);
});

test("the same skill in two folders stays selected", async (t) => {
  const { run, write, claude, project } = fixture(t);
  for (const folder of [".claude", ".codex"])
    write(`project/${folder}/skills/both/SKILL.md`, "Both");
  const file = claude(ID, [
    ["user", "Check it"],
    [
      "assistant",
      [
        {
          type: "tool_use",
          name: "Bash",
          input: { command: `cat ${project}/.codex/skills/both/SKILL.md` },
        },
      ],
    ],
  ]);
  const { bundle } = await preview(run, ["--session", file]);
  assert.deepEqual(
    named(bundle, "skill").map((item) => item.title),
    ["both"],
  );
});

test("sessions without a conversation are passed over", async (t) => {
  const { run, claude } = fixture(t);
  for (let index = 0; index < 10; index++)
    claude(`${index}2345678-1111-4111-8111-111111111111`, [
      ["user", "<command-name>/clear</command-name>"],
    ]);
  claude(
    "a2345678-1111-4111-8111-111111111111",
    [["user", "Side task"]],
    "agent-a2345678",
  );
  const { err } = await preview(run);
  assert.ok(err.includes("Fix it"), err);
  assert.ok(err.includes("Earlier work"), err);
  assert.ok(!err.includes("Side task"), err);
});

test("credential folders in a skill are left out", async (t) => {
  const { run, write } = fixture(t);
  for (const path of [
    "secrets/prod.json",
    "a/credentials/aws",
    "credentials.txt",
  ])
    write(`.claude/skills/review/${path}`, "abc123");
  const { out, err } = await preview(run);
  assert.ok(!out.includes("abc123"));
  assert.ok(err.includes("SKILL.md, 3 left out"), err);
});

test("the review shows the branch and commit, whatever Git is told", async (t) => {
  const { run, git, home } = fixture(t);
  git("checkout", "-q", "-b", "quiet-branch");
  const other = join(home, "other");
  execFileSync("git", ["init", "-q", "-b", "wrong", other]);
  const { bundle, err } = await preview(run, [], {
    extra: {
      GIT_DIR: join(other, ".git"),
      GIT_WORK_TREE: other,
    },
  });
  assert.equal(bundle.repository.branch, "quiet-branch");
  assert.equal(bundle.repository.name, "team/repo");
  assert.ok(
    err.includes(`Branch quiet-branch, commit ${bundle.repository.commit}`),
    err,
  );
});

test("a worktree inside the project doesn't replace its session", async (t) => {
  const { run, git, claude, project } = fixture(t);
  const worktree = join(project, ".claude/worktrees/wt");
  git("worktree", "add", "-q", "-b", "feature", worktree);
  const file = claude(
    "99999999-9999-4999-8999-999999999999",
    [["user", "Worktree work"]],
    undefined,
    worktree,
  );
  assert.ok((await preview(run)).err.includes("\nFix it"));
  assert.ok(
    (await preview(run, [], { cwd: worktree })).err.includes("\nWorktree work"),
  );
  // Once it is gone, the main checkout's branch and commit aren't its own.
  git("worktree", "remove", "--force", worktree);
  const { bundle } = await preview(run, ["--session", file]);
  assert.deepEqual(bundle.repository, { name: "team/repo" });
});

test("a fork whose worktree is gone keeps its history", async (t) => {
  const { run, write, project } = fixture(t);
  const parent = "66666666-6666-4666-8666-666666666666";
  const lines = (id, cwd, first, text, base) =>
    [
      {
        type: "session_meta",
        payload: { id, cwd, ...(base ? { history_base: base } : {}) },
      },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text }],
        },
      },
    ]
      .map((record, index) =>
        JSON.stringify({ ...record, ordinal: first + index }),
      )
      .join("\n") + "\n";
  const kept = lines(parent, project, 0, "Kept");
  write(`.codex/sessions/rollout-${parent}.jsonl`, kept);
  const child = "77777777-7777-4777-8777-777777777777";
  const file = write(
    `.codex/sessions/rollout-${child}.jsonl`,
    lines(child, join(project, ".claude/worktrees/gone"), 2, "Child", {
      thread_id: parent,
      end_ordinal_exclusive: 2,
      end_byte_offset: Buffer.byteLength(kept),
    }),
  );
  const { bundle } = await preview(run, ["--session", file]);
  assert.deepEqual(
    bundle.messages.map((message) => message.text),
    ["Kept", "Child"],
  );
});

test("a long list of changes still warns", async (t) => {
  const { run, write } = fixture(t);
  const name = "x".repeat(200);
  for (let index = 0; index < 6_000; index++)
    write(`project/${name}${index}`, "");
  const { bundle } = await preview(run);
  assert.equal(bundle.repository.uncommitted, true);
});

test("a revoked sign-in that can't be forgotten is replaced", async (t) => {
  const { run, home } = fixture(t);
  const { origin, seen, rotate } = await service(t);
  assert.equal((await run(["--yes"], { origin })).code, 0);
  rotate();
  const folder = join(home, ".config/orka-handoff");
  const modes = [
    folder,
    ...readdirSync(folder).map((name) => join(folder, name)),
  ];
  for (const path of modes) chmodSync(path, path === folder ? 0o500 : 0o400);
  try {
    const result = await run(["--yes"], { origin });
    assert.equal(result.code, 0, result.err);
  } finally {
    for (const path of modes) chmodSync(path, path === folder ? 0o700 : 0o600);
  }
  assert.equal(seen.starts, 2);
});

test("an agent's unsaved or unclear session is never replaced by another", async (t) => {
  const { run } = fixture(t);
  const unsaved = "88888888-8888-4888-8888-888888888888";
  for (const extra of [
    { CLAUDE_CODE_SESSION_ID: unsaved },
    { CODEX_THREAD_ID: unsaved },
    { CLAUDE_CODE_SESSION_ID: ID, CODEX_THREAD_ID: RELATED },
  ]) {
    const result = await run(["--preview"], { extra });
    assert.equal(result.code, 1);
    assert.match(result.err, /Pass --session/);
    assert.ok(!result.err.includes("Fix it"));
    const chosen = await run(["--preview", "--session", ID], { extra });
    assert.equal(chosen.code, 0, chosen.err);
  }
});

test("another worktree's session doesn't stand in for a cleared one", async (t) => {
  const { run, git, claude, home } = fixture(t);
  const worktree = join(home, "linked");
  git("worktree", "add", "-q", "-b", "feature", worktree);
  for (const id of [ID, RELATED])
    claude(id, [["user", "<command-name>/clear</command-name>"]]);
  claude(
    "99999999-9999-4999-8999-999999999999",
    [["user", "Worktree work"]],
    undefined,
    worktree,
  );
  const { code, err } = await run(["--preview"]);
  assert.equal(code, 1);
  assert.match(err, /no readable conversation/);
});

test("a worktree folder left behind doesn't report this checkout's branch", async (t) => {
  const { run, claude, write, project } = fixture(t);
  write("project/.claude/worktrees/wt/node_modules/a.js", "");
  const file = claude(
    "99999999-9999-4999-8999-999999999999",
    [["user", "Worktree work"]],
    undefined,
    join(project, ".claude/worktrees/wt"),
  );
  const { bundle } = await preview(run, ["--session", file]);
  assert.deepEqual(bundle.repository, { name: "team/repo" });
});

test("a fork from a deleted folder keeps its history below a linked or Git home", async (t) => {
  const { run, write, home, project } = fixture(t);
  execFileSync("git", ["init", "-q", home]);
  symlinkSync(project, join(home, "ln"));
  const parent = "66666666-6666-4666-8666-666666666666";
  const child = "77777777-7777-4777-8777-777777777777";
  const lines = (id, cwd, first, text, base) =>
    [
      {
        type: "session_meta",
        payload: { id, cwd, ...(base ? { history_base: base } : {}) },
      },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text }],
        },
      },
    ]
      .map((record, index) =>
        JSON.stringify({ ...record, ordinal: first + index }),
      )
      .join("\n") + "\n";
  for (const cwd of [join(home, "work/gone"), join(home, "ln/gone")]) {
    const kept = lines(parent, cwd, 0, "Kept");
    write(`.codex/sessions/rollout-${parent}.jsonl`, kept);
    const file = write(
      `.codex/sessions/rollout-${child}.jsonl`,
      lines(child, cwd, 2, "Child", {
        thread_id: parent,
        end_ordinal_exclusive: 2,
        end_byte_offset: Buffer.byteLength(kept),
      }),
    );
    const { bundle } = await preview(run, ["--session", file]);
    assert.deepEqual(
      bundle.messages.map((message) => message.text),
      ["Kept", "Child"],
    );
  }
});

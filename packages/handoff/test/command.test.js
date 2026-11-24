import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
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

async function service(t, { handoffs = 1, failures = 0 } = {}) {
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
    if (request.url === "/v2/instance") return send(200, { handoffs });
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
    if (request.headers.authorization !== `Bearer ${valid}`)
      return send(401, { error: "Sign in required" });
    if (request.url === "/v2/handoffs" && request.method === "POST") {
      seen.creates.push(body);
      if (seen.creates.length <= failures) return send(503, { error: "Busy" });
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
      ["plan", "Approved plan"],
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
  const lines = (records) =>
    records.map((record) => JSON.stringify(record)).join("\n") + "\n";
  const user = (value) => ({
    type: "response_item",
    payload: {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: value }],
    },
  });
  const kept = lines([
    { type: "session_meta", payload: { id: parent, cwd: project } },
    user("Kept é"),
  ]);
  const path = write(
    `.codex/sessions/rollout-${parent}.jsonl`,
    kept + lines([user("After the fork")]),
  );
  const forked = write(
    `.codex/sessions/rollout-${child}.jsonl`,
    lines([
      {
        type: "session_meta",
        payload: {
          id: child,
          cwd: project,
          history_base: {
            thread_id: parent,
            end_byte_offset: Buffer.byteLength(kept),
          },
        },
      },
      user("Child"),
    ]),
  );
  assert.equal(
    (await run(["--yes", "--no-context", "--session", forked], { origin }))
      .code,
    0,
  );
  assert.deepEqual(
    seen.creates.at(-1).messages.map((message) => message.text),
    ["Kept é", "Child"],
  );
  rmSync(path);
  const missing = await run(["--yes", "--no-context", "--session", forked], {
    origin,
  });
  assert.equal(missing.code, 1);
  assert.ok(
    missing.err.includes("history is missing") && !missing.err.includes(home),
  );
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

import assert from "node:assert/strict";
import test from "node:test";
import {
  HandoffError,
  LIMITS,
  buildBundle,
  continuationPrompt,
  decodeLines,
  readSession,
  redactText,
  safePath,
} from "../src/core.js";

const id = "11111111-1111-4111-8111-111111111111";
const claude = (type, content, extra = {}) => ({
  type,
  sessionId: id,
  cwd: "/work",
  message: { role: type, content },
  ...extra,
});
const text = (value) => [{ type: "text", text: value }];
const meta = { type: "session_meta", payload: { id, cwd: "/work" } };
const session = (extra = {}) => ({
  tool: "claude",
  title: "Title",
  messages: [{ role: "user", text: "Hi" }],
  ...extra,
});
const bundle = (extra) =>
  buildBundle({ session: session(), requestId: id, ...extra }).bundle;

test("redaction matches the desktop rules", () => {
  const github = `ghp_${"a".repeat(36)}`;
  for (const [input, expected] of [
    [`use ${github} now`, "use [REDACTED] now"],
    [`Check this key: sk-${"x".repeat(24)}`, "Check this key: [REDACTED]"],
    ["export API_KEY=short\nPORT=3000", "export API_KEY=[REDACTED]\nPORT=3000"],
    ["Authorization: Bearer abc.def==", "Authorization: Bearer [REDACTED]"],
    [
      '{ "password": "opaque", "count": 3 }',
      '{ "password": "[REDACTED]", "count": 3 }',
    ],
    [
      '{"body":"{\\"password\\":\\"opaque\\"}"}',
      '{"body":"{\\"password\\":\\"[REDACTED]\\"}"}',
    ],
    ['{"p\\u0061ssword":"opaque"}', '{"p\\u0061ssword":"[REDACTED]"}'],
    [
      "-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----",
      "[REDACTED]",
    ],
    [
      "the password changed and tokens: 12",
      "the password changed and tokens: 12",
    ],
  ]) {
    assert.equal(redactText(input), expected);
    assert.equal(redactText(expected), expected);
  }
});

test("Claude sessions keep the conversation and leave out setup, tools and subagents", () => {
  const read = readSession([
    claude("user", "<environment_context>cwd</environment_context>"),
    claude("user", "# Fix search\nKeep both lines"),
    claude("user", [{ type: "tool_result", content: "hidden" }]),
    claude("user", "Injected", { isMeta: true }),
    claude("assistant", text("Subagent"), { isSidechain: true }),
    claude("assistant", [
      ...text("Done."),
      { type: "tool_use", name: "Skill", input: { skill: "review" } },
    ]),
    claude("user", "<command-name>/polish</command-name>"),
    claude("assistant", [
      { type: "tool_use", name: "ExitPlanMode", input: { plan: "First" } },
    ]),
    claude("assistant", [
      { type: "tool_use", name: "ExitPlanMode", input: { plan: "Final" } },
    ]),
    claude("assistant", [
      {
        type: "tool_use",
        name: "Bash",
        input: { command: "cat ~/.claude/skills/orka/SKILL.md" },
      },
    ]),
  ]);
  assert.deepEqual(read.messages, [
    { role: "user", text: "# Fix search\nKeep both lines" },
    { role: "assistant", text: "Done." },
  ]);
  assert.equal(read.title, "Fix search");
  assert.equal(read.plan, "Final");
  assert.deepEqual(read.skills, {
    names: ["polish", "review"],
    folders: ["~/.claude/skills/orka"],
  });
});

test("Codex mirrors are removed without losing repeated turns", () => {
  const response = (role, value) => ({
    type: "response_item",
    payload: {
      type: "message",
      role,
      content: [{ type: "input_text", text: value }],
    },
  });
  const event = (type, message) => ({
    type: "event_msg",
    payload: { type, message },
  });
  const read = readSession([
    meta,
    event("user_message", "Again"),
    response("user", "Again"),
    response("assistant", "One"),
    event("agent_message", "One"),
    event("user_message", "Again"),
    response("user", "Again"),
    event("agent_message", "Only an event"),
    {
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        channel: "analysis",
        content: "Hidden",
      },
    },
    {
      type: "response_item",
      payload: { type: "agent_message", author: "child", content: "Hidden" },
    },
  ]);
  assert.deepEqual(
    read.messages.map((message) => message.text),
    ["Again", "One", "Again", "Only an event"],
  );
});

test("Pi sessions follow the open branch and reject a broken tree", () => {
  const entry = (key, parentId, role, value) => ({
    type: "message",
    id: key,
    parentId,
    message: { role, content: text(value) },
  });
  const records = [
    { type: "session", id, cwd: "/work", version: 3 },
    entry("a", null, "user", "Start"),
    entry("b", "a", "assistant", "Abandoned"),
    entry("c", "a", "assistant", "Kept"),
  ];
  assert.deepEqual(
    readSession(records).messages.map((message) => message.text),
    ["Start", "Kept"],
  );
  assert.throws(
    () => readSession([...records, entry("d", "missing", "user", "x")]),
    HandoffError,
  );
});

test("a session being written may end mid-record, but damage elsewhere is refused", () => {
  const line = JSON.stringify(claude("user", "Hi"));
  assert.equal(decodeLines(`${line}\n{"type":"us`).length, 1);
  assert.throws(() => decodeLines(`{broken\n${line}\n`), HandoffError);
  assert.throws(() => readSession([{ hello: 1 }]), HandoffError);
  assert.throws(
    () =>
      readSession([
        claude("assistant", [{ type: "tool_use", name: "Bash", input: {} }]),
      ]),
    HandoffError,
  );
});

test("every string in a bundle is redacted, including context, titles and repository", () => {
  const secret = `ghp_${"b".repeat(36)}`;
  const result = buildBundle({
    session: session({
      title: secret,
      messages: [{ role: "user", text: secret }],
    }),
    items: [
      {
        kind: "memory",
        title: secret,
        files: [{ path: "a.md", text: `x\0 ${secret}` }],
        selected: true,
        size: 3,
      },
      {
        kind: "session",
        title: "S",
        tool: "pi",
        messages: [{ role: "user", text: secret }],
        path: "/Users/someone",
      },
    ],
    repository: { name: "r", branch: secret },
    requestId: id,
  });
  const encoded = JSON.stringify(result.bundle);
  assert.ok(
    !encoded.includes(secret) &&
      !encoded.includes("/Users/someone") &&
      !encoded.includes("\\u0000"),
  );
  assert.equal(result.redacted, 6);
  assert.deepEqual(Object.keys(result.bundle.items[0]), [
    "kind",
    "title",
    "files",
  ]);
});

test("limits are checked before upload", () => {
  assert.throws(
    () =>
      bundle({
        session: session({
          messages: [{ role: "user", text: "x".repeat(LIMITS.bytes) }],
        }),
      }),
    /limit is/,
  );
  assert.throws(
    () =>
      bundle({
        items: Array(LIMITS.items + 1).fill({
          kind: "plan",
          title: "p",
          files: [],
        }),
      }),
    HandoffError,
  );
  assert.throws(
    () =>
      bundle({
        items: [
          { kind: "plan", title: "p", files: [{ path: "../x", text: "x" }] },
        ],
      }),
    HandoffError,
  );
  assert.equal(
    [...bundle({ title: "😀".repeat(300) }).title].length,
    LIMITS.title,
  );
  for (const path of [
    "/a",
    "a/../b",
    "a//b",
    ".env",
    "x/.env.local",
    "prod.env",
    "a\\b",
    "a\nb",
  ])
    assert.ok(!safePath(path), path);
  for (const path of ["SKILL.md", "references/a.md", "environment.md"])
    assert.ok(safePath(path), path);
});

test("the prompt carries the link and not the conversation", () => {
  const prompt = continuationPrompt(
    "https://example.test/handoff/abc",
    "codex",
  );
  assert.ok(
    prompt.includes("https://example.test/handoff/abc/markdown") &&
      prompt.length < 1000,
  );
});

test("a title is redacted before it is shortened", () => {
  const text =
    'Connect with {"user":"admin","host":"db.example.test","port":5432,"password":"correct horse battery staple and more words"} please';
  const session = readSession([
    {
      type: "user",
      sessionId: "a",
      cwd: "/x",
      message: { role: "user", content: text },
    },
  ]);
  assert.ok(!session.title.includes("correct horse"));
  const { bundle } = buildBundle({ session, requestId: "r" });
  assert.ok(!JSON.stringify(bundle).includes("correct horse"));
});

test("redaction and path search stay quick on long lines", () => {
  const started = Date.now();
  for (const text of [
    '\\"a\\":\\"b\\",'.repeat(80_000),
    '"'.repeat(1_000_000),
    "-----BEGIN PRIVATE KEY-----".repeat(40_000),
  ])
    redactText(text);
  readSession([
    {
      type: "assistant",
      sessionId: "a",
      cwd: "/x",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "Done" },
          {
            type: "tool_use",
            name: "Write",
            input: { x: "a/".repeat(500_000) },
          },
        ],
      },
    },
  ]);
  assert.ok(Date.now() - started < 5_000);
});

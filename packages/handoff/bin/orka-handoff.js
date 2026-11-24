#!/usr/bin/env node
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import {
  apiOrigin,
  call,
  requireHandoffs,
  saveToken,
  savedToken,
  signIn,
  upload,
} from "../src/api.js";
import {
  HandoffError,
  TOOL_NAMES,
  buildBundle,
  continuationPrompt,
} from "../src/core.js";
import {
  chooseSession,
  collectContext,
  openSession,
  repository,
  sessionWorkspace,
  toolHomes,
  workspace,
} from "../src/local.js";

const HELP = `Share a coding session and its context as one link.

  orka-handoff                 Share the current session
  orka-handoff list            Show your active links
  orka-handoff revoke <id>     Stop a link from working
  orka-handoff sign-out        Sign this computer out

Options
  --session <id|file>  Share a specific session
  --title <text>       Change the title
  --days <1-90>        How long the link works (default 30)
  --no-context         Share only the conversation
  --items <1,3>        Choose context by number
  --preview            Show what would be shared, then stop
  --yes                Share the selected items without asking
  --json               Print the result as JSON
`;

// Titles come from sessions, so control sequences must not reach the terminal.
const plain = (text) =>
  String(text).replace(/[\p{Cc}\u202a-\u202e\u2066-\u2069]+/gu, " ");
const say = (text = "") => process.stderr.write(`${text}\n`);
const kb = (bytes) =>
  bytes < 1000 ? "<1 KB" : `${Math.round(bytes / 1000)} KB`;

function show(session, repo, items) {
  say(`\n${plain(session.title)}`);
  say(
    `${TOOL_NAMES[session.tool]}, ${session.messages.length} messages${repo ? `, ${plain(repo.name)}` : ""}`,
  );
  if (repo?.uncommitted) say("Your uncommitted changes are not shared.");
  if (items.length) say("\nContext");
  items.forEach((item, index) =>
    say(
      `  ${item.selected ? "[x]" : "[ ]"} ${String(index + 1).padStart(2)}  ${item.kind.padEnd(8)}${plain(item.title).slice(0, 70)}  ${kb(item.size)}`,
    ),
  );
  say("\nAnyone with the link can read this. Recognized secrets are removed.");
}

function selectNumbers(items, value) {
  const wanted = new Set(
    value
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const number = Number(part);
        if (!Number.isInteger(number) || number < 1 || number > items.length)
          throw new HandoffError(`Context item ${plain(part)} doesn’t exist.`);
        return number - 1;
      }),
  );
  items.forEach((item, index) => (item.selected = wanted.has(index)));
}

async function review(session, repo, items) {
  const lines = createInterface({
    input: process.stdin,
    output: process.stderr,
  });
  try {
    for (;;) {
      show(session, repo, items);
      const answer = (
        await lines.question(
          `Press Return to share${items.length ? ", enter numbers to change context" : ""}, or q to cancel: `,
        )
      ).trim();
      if (!answer) return true;
      if (/^q(uit)?$/i.test(answer)) return false;
      for (const part of answer.split(/[\s,]+/)) {
        const item = items[Number(part) - 1];
        if (item) item.selected = !item.selected;
        else say(`There is no item ${plain(part)}.`);
      }
    }
  } finally {
    lines.close();
  }
}

function openBrowser(url) {
  if (!process.stderr.isTTY || process.env.SSH_CONNECTION) return;
  const [command, ...args] =
    process.platform === "darwin"
      ? ["open", url]
      : process.platform === "win32"
        ? ["explorer.exe", url]
        : ["xdg-open", url];
  spawn(command, args, { stdio: "ignore", detached: true })
    .on("error", () => {})
    .unref();
}

async function authorized(origin, action) {
  const authorize = () =>
    signIn(origin, ({ code, url }) => {
      say(`\nSign in to share. Open ${url}`);
      say(`Check that the page shows this code: ${code}`);
      say("Waiting for approval…");
      openBrowser(url);
    });
  const saved = savedToken(origin);
  if (saved)
    try {
      return await action(saved);
    } catch (error) {
      if (error.status !== 401) throw error;
      saveToken(origin);
    }
  return action(await authorize());
}

async function share(origin, options) {
  const homes = toolHomes();
  const here = workspace(process.cwd());
  const session = openSession(chooseSession(here, homes, options), homes);
  const space = sessionWorkspace(session, here);
  const items = options["no-context"]
    ? []
    : collectContext(session, space, homes);
  if (options.title?.trim()) session.title = options.title.trim();
  if (options.items !== undefined) selectNumbers(items, options.items);
  const repo = repository(space);
  const days = options.days === undefined ? undefined : Number(options.days);
  if (
    days !== undefined &&
    !(Number.isInteger(days) && days >= 1 && days <= 90)
  )
    throw new HandoffError("Choose between 1 and 90 days.");
  const build = (requestId) =>
    buildBundle({
      session,
      items: items.filter((item) => item.selected),
      repository: repo,
      expiresInDays: days,
      requestId,
    });
  const asks =
    process.stdin.isTTY &&
    process.stderr.isTTY &&
    !options.yes &&
    !options.preview;
  if (asks) {
    if (!(await review(session, repo, items)))
      return say("Nothing was shared.");
  } else show(session, repo, items);
  const { bundle, size, redacted } = build(randomUUID());
  if (options.preview || (!asks && !options.yes)) {
    say(
      `Nothing was shared. This handoff is ${kb(size)}${redacted ? `, with secrets removed from ${redacted} places` : ""}.`,
    );
    if (!options.preview) {
      say("Run again with --yes to share the selected items.");
      process.exitCode = 2;
    }
    return;
  }
  await requireHandoffs(origin);
  const result = await authorized(origin, (token) =>
    upload(origin, bundle, token),
  );
  if (options.json)
    return console.log(
      JSON.stringify({
        id: result.id,
        url: result.url,
        expiresAt: result.expiresAt,
        redacted,
      }),
    );
  say(
    `\nShared ${kb(size)}${redacted ? `, with secrets removed from ${redacted} places` : ""}. The link expires on ${new Date(result.expiresAt).toLocaleDateString()}.`,
  );
  say(`To stop sharing: orka-handoff revoke ${result.id}\n`);
  console.log(result.url);
  say(
    `\nPrompt for the next agent:\n${continuationPrompt(result.url, session.tool)}`,
  );
}

async function main() {
  const { values: options, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      session: { type: "string" },
      title: { type: "string" },
      days: { type: "string" },
      items: { type: "string" },
      api: { type: "string" },
      "no-context": { type: "boolean" },
      preview: { type: "boolean" },
      yes: { type: "boolean", short: "y" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [command = "share", id] = positionals;
  if (options.help) return console.log(HELP);
  const origin = apiOrigin(options.api ?? process.env.ORKA_HANDOFF_API);
  switch (command) {
    case "share":
      return share(origin, options);
    case "list": {
      const { items } = await authorized(origin, (token) =>
        call(origin, "/v2/handoffs", { token }),
      );
      if (options.json) return console.log(JSON.stringify(items));
      if (!items.length) return say("You have no active links.");
      for (const item of items)
        console.log(
          `${item.id}  ${plain(item.title)}  expires ${new Date(item.expiresAt).toLocaleDateString()}`,
        );
      return;
    }
    case "revoke": {
      if (!id)
        throw new HandoffError("Pass the ID shown by orka-handoff list.");
      await authorized(origin, (token) =>
        call(origin, "/v2/handoffs/revoke", { token, body: { id } }),
      );
      return say("The link no longer works.");
    }
    case "sign-out": {
      const token = savedToken(origin);
      if (token)
        await call(origin, "/v2/handoffs/device/sign-out", {
          token,
          body: {},
        }).catch((error) => {
          if (error.status !== 401) throw error;
        });
      saveToken(origin);
      return say(
        "Signed out on this computer. Existing links keep working until they expire or you revoke them.",
      );
    }
    default:
      throw new HandoffError(`Unknown command. Run orka-handoff --help.`);
  }
}

main().catch((error) => {
  const known =
    error instanceof HandoffError || error.code?.startsWith?.("ERR_PARSE_ARGS");
  say(known ? error.message : "Something went wrong. Nothing was shared.");
  if (!known && process.env.ORKA_HANDOFF_DEBUG) say(error.stack);
  process.exitCode = 1;
});

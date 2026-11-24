#!/usr/bin/env node
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { setTimeout as delay } from "node:timers/promises";
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
  --host               Use this host’s provisioned credential; no browser sign-in
  --session <id|file>  Share a specific session
  --title <text>       Change the title
  --days <1-90>        How long the link works (default 30)
  --no-context         Share only the conversation
  --items <1,3>        Choose context by number
  --preview            Show what would be shared, then stop
                       Add --json to print its full contents
  --yes                Share the selected items without asking
  --json               Print the result as JSON
`;

// Titles come from sessions, so control sequences must not reach the terminal.
const plain = (text) =>
  String(text).replace(/[\p{Cc}\u202a-\u202e\u2066-\u2069]+/gu, " ");
const say = (text = "") => process.stderr.write(`${text}\n`);
const kb = (bytes) =>
  bytes < 1000 ? "<1 KB" : `${Math.round(bytes / 1000)} KB`;

/** Keeps line breaks, so a whole file can be read before sharing it. */
const plainLines = (text) => text.split(/\r?\n/).map(plain).join("\n");

function details(item) {
  const files = item.files?.map((file) => plain(file.path)) ?? [];
  const left = item.skipped ? `, ${item.skipped} left out` : "";
  // A skill is a folder, so its name alone doesn't say what is shared.
  return item.kind === "skill" ? `${files.join(", ")}${left}` : "";
}

const checkoutLine = ({ branch, commit }) =>
  [branch && `Branch ${plain(branch)}`, commit && `commit ${commit}`]
    .filter(Boolean)
    .join(", ");

function show(session, repo, items) {
  say(`\n${plain(session.title)}`);
  say(
    `${TOOL_NAMES[session.tool]}, ${session.messages.length} messages${repo ? `, ${plain(repo.name)}` : ""}`,
  );
  if (repo?.branch || repo?.commit) say(checkoutLine(repo));
  if (repo?.uncommitted) say("Your uncommitted changes are not shared.");
  if (items.length) say("\nContext");
  items.forEach((item, index) => {
    say(
      `  ${item.selected ? "[x]" : "[ ]"} ${String(index + 1).padStart(2)}  ${item.kind.padEnd(8)}${plain(item.title).slice(0, 70)}  ${kb(item.size)}`,
    );
    if (item.selected && details(item)) say(`          ${details(item)}`);
  });
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

/** Prints the exact text a link would expose, after secrets are removed. */
function showContents(bundle) {
  const { repository: repo } = bundle;
  say(`\n# ${plain(bundle.title)}`);
  if (repo) {
    say(`\nRepository ${plain(repo.name)}`);
    if (repo.branch || repo.commit) say(checkoutLine(repo));
    if (repo.uncommitted) say("Has uncommitted changes");
  }
  const messages = (list) =>
    list.forEach((message) =>
      say(
        `\n## ${message.role === "user" ? "You" : "Assistant"}\n\n${plainLines(message.text)}`,
      ),
    );
  messages(bundle.messages);
  for (const item of bundle.items) {
    say(`\n# ${item.kind}: ${plain(item.title)}`);
    if (item.messages) messages(item.messages);
    for (const file of item.files ?? [])
      say(`\n## ${plain(file.path)}\n\n${plainLines(file.text)}`);
  }
}

async function review(session, repo, items, build) {
  const lines = createInterface({
    input: process.stdin,
    output: process.stderr,
    prompt: "",
  });
  let open = true;
  const closed = new Promise((resolve) =>
    lines.once("close", () => {
      open = false;
      resolve("q");
    }),
  );
  try {
    for (;;) {
      show(session, repo, items);
      // Drop keys pressed before the list was on screen. They can't approve it.
      await delay(150);
      if (!open) return undefined;
      lines.write(null, { ctrl: true, name: "u" });
      const question = `Press Return to share, ${items.length ? "numbers to change context, " : ""}v to read it all, or q to cancel: `;
      // Ctrl-C and Ctrl-D close the prompt without answering it.
      const answer = (
        await Promise.race([lines.question(question).catch(() => "q"), closed])
      ).trim();
      if (/^q(uit)?$/i.test(answer)) return undefined;
      if (!answer || /^v(iew)?$/i.test(answer)) {
        try {
          const built = build();
          if (!answer) return built;
          showContents(built.bundle);
        } catch (error) {
          // Too much was chosen. Keep the choices so they can be changed.
          if (!(error instanceof HandoffError)) throw error;
          say(`\n${plain(error.message)}`);
        }
        continue;
      }
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
  const authorize = async () => {
    const credential = await signIn(origin, ({ code, url }) => {
      say(`\nSign in to Orka. Open ${url}`);
      say(`Check that the page shows this code: ${plain(code)}`);
      say("Waiting for approval…");
      openBrowser(url);
    });
    try {
      saveToken(origin, credential);
    } catch {
      say(
        "This sign-in couldn’t be saved, so you’ll be asked again next time.",
      );
    }
    return credential.token;
  };
  const saved = savedToken(origin);
  if (saved)
    try {
      return await action(saved);
    } catch (error) {
      if (error.status !== 401) throw error;
      try {
        saveToken(origin);
      } catch {
        // The new sign-in below is used even if neither can be saved.
      }
    }
  return action(await authorize());
}

async function share(origin, options, hostToken) {
  const homes = toolHomes();
  const here = workspace(process.cwd());
  const session = chooseSession(here, homes, options);
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
  const requestId = randomUUID();
  const build = () =>
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
  let built;
  if (asks) {
    built = await review(session, repo, items, build);
    if (!built) return say("Nothing was shared.");
  } else {
    show(session, repo, items);
    built = build();
  }
  const { bundle, size, redacted } = built;
  if (options.preview || (!asks && !options.yes)) {
    if (options.json) console.log(JSON.stringify(bundle));
    say(
      `Nothing was shared. This handoff is ${kb(size)}${redacted ? `, with secrets removed from ${redacted} places` : ""}.`,
    );
    if (!options.preview) {
      say("Run again with --yes to share the selected items.");
      process.exitCode = 2;
    }
    return;
  }
  await requireHandoffs(origin, hostToken ? { host: true } : undefined);
  const result = hostToken
    ? await upload(origin, bundle, hostToken, { host: true })
    : await authorized(origin, (token) => upload(origin, bundle, token));
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
  say(
    `To stop sharing: orka-handoff revoke ${result.id}${hostToken ? " --host" : ""}\n`,
  );
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
      host: { type: "boolean" },
      "no-context": { type: "boolean" },
      preview: { type: "boolean" },
      yes: { type: "boolean", short: "y" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [command = "share", id, ...extra] = positionals;
  if (options.help) return console.log(HELP);
  const configuredApi = process.env.ORKA_HANDOFF_API;
  const origin = apiOrigin(options.api ?? configuredApi);
  let hostToken;
  if (options.host) {
    if (command !== "share" && command !== "revoke")
      throw new HandoffError("Host mode only supports share and revoke.");
    if (command === "share" && !options.session)
      throw new HandoffError(
        "Pass --session with the exact session ID or file to share from this host.",
      );
    if (!configuredApi || origin !== apiOrigin(configuredApi))
      throw new HandoffError(
        "Host mode requires its configured ORKA_HANDOFF_API address.",
      );
    hostToken = process.env.ORKA_HANDOFF_HOST_TOKEN;
    if (!/^orka_handoff_host_[a-f0-9]{64}$/.test(hostToken ?? ""))
      throw new HandoffError(
        "Host mode requires a provisioned ORKA_HANDOFF_HOST_TOKEN.",
      );
  }
  if (extra.length || (id && command !== "revoke"))
    throw new HandoffError(
      `${plain(extra[0] ?? id)} wasn’t expected. Run orka-handoff --help.`,
    );
  switch (command) {
    case "share":
      return share(origin, options, hostToken);
    case "list": {
      await requireHandoffs(origin);
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
        throw new HandoffError(
          hostToken
            ? "Pass the ID shown when the host shared the link."
            : "Pass the ID shown by orka-handoff list.",
        );
      await requireHandoffs(origin, hostToken ? { host: true } : undefined);
      const revoke = (token) =>
        call(origin, "/v2/handoffs/revoke", { token, body: { id } });
      const { revoked } = hostToken
        ? await revoke(hostToken)
        : await authorized(origin, revoke);
      if (!revoked)
        throw new HandoffError(
          hostToken
            ? "This host has no active link with that ID."
            : "You have no active link with that ID. Run orka-handoff list to check.",
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
  say(
    known
      ? plain(error.message)
      : "Something went wrong. Set ORKA_HANDOFF_DEBUG=1 to see why.",
  );
  if (!known && process.env.ORKA_HANDOFF_DEBUG) say(error.stack);
  process.exitCode = 1;
});

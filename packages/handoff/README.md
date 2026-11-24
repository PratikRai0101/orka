# orka-handoff

Share a coding session, and the context it needs, as one link. Neither you nor
the people you send it to need Orka installed.

The package is not on npm yet, so don't run it with `npx`. With Node.js 20.1 or
later, run it from a checkout of this repository:

```sh
node /path/to/orka/packages/handoff/bin/orka-handoff.js
```

Run it inside a project. It picks the latest Claude Code, Codex or Pi session
there, or the agent's own session when an agent runs it, shows what it will share, and prints a link. The first time, it opens the
Dashboard so you can sign in and approve this command.

## What is shared

- The conversation: your messages and the assistant's replies. Tool calls, tool
  output, reasoning and attachments stay on your computer.
- Project instructions, the skills the session used, its plan, and sessions you
  mentioned in it. Memory notes start selected only if their type is `project` or
  `reference`.
- A skill is its whole folder, except files that usually hold credentials.

Review the list before you confirm. Enter `v` to read everything in it, or run
with `--preview --json`. Orka redacts credentials it recognizes before
upload, and the service refuses bundles that still contain one. Recognition is not
complete, so read the preview.

Anyone with the link can read the handoff until it expires or you revoke it. Links
last 30 days by default and 90 at most.

## Commands

| Command                    | What it does                  |
| -------------------------- | ----------------------------- |
| `orka-handoff`             | Share a session               |
| `orka-handoff list`        | Show your handoffs            |
| `orka-handoff revoke <id>` | Stop a link working           |
| `orka-handoff sign-out`    | Revoke this computer's access |

Options for sharing: `--session <id or file>`, `--title`, `--days`,
`--no-context`, `--items`, `--preview`, `--yes`, `--json`. Without a terminal,
pass `--yes` to share; otherwise the command only prints the preview.

Set `--api` or `ORKA_HANDOFF_API` to use another managed service. Self-hosted
services do not offer handoffs yet.

Without Node.js, upload the session file at `/handoff/new` on the Dashboard.

## Reading sessions

`src/core.js` has no Node.js dependencies. The Dashboard carries a copy, so change
it here first. Its conversation and redaction output must match
`apps/mac/src-tauri/src/session_presentation.rs` and `session_redaction.rs`.

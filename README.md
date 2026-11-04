# Bullpen

A local team of persistent AI bots, powered by the [Claude Code](https://docs.claude.com/claude-code) CLI.

You create bots — each with its own name, role, instructions, working folder, memory and chat — and talk to them like coworkers. One **primary bot** takes any request and hands the work to the right specialist. Specialists do the work in their own long-running conversations, **report back automatically**, and can delegate to or message each other when they need to. You see it all in one chat app on your own computer.

- **Zero dependencies.** Plain Node.js. No `npm install`, no database, no build step.
- **Local first.** Runs on `127.0.0.1`. Every chat, memory file, page and routine is a plain file in one data folder.
- **Uses your Claude Code login.** Each bot turn is a `claude -p` run that resumes that bot's session.

## What it does

| | |
|---|---|
| **Persistent bots** | Each bot keeps one Claude Code session going for weeks. If a session is lost or reset, the bot restarts with its memory plus a recap of the recent chat. |
| **Primary bot** | The default bot. Bring it anything; it delegates to specialists, waits for their reports, and gives you the result. |
| **Delegation with report-back** | `delegate_task` hands work to a teammate. Their final reply goes back to the delegator as a new turn. Track everything on the **Tasks** board. |
| **Bots talking to bots** | Bots can send each other FYI messages, and @mention each other in **group chats**. |
| **Cards** | Question cards with clickable options, approval cards for risky actions, draft cards for emails you send yourself, page cards, file cards, task cards. |
| **Approvals** | By default a bot reads freely but needs your OK to edit files or run commands. Approve once, always allow, or deny, right in the chat. |
| **Memory** | Each bot has its own long-term memory, plus a shared memory every bot sees. Bots update it themselves; you can edit it too. |
| **Skills** | Reusable step-by-step procedures any bot can read and follow. Bots save new ones as they work things out. |
| **Pages (Library)** | Bots save reports, dashboards and trackers as pages that open beside the chat, sandboxed. |
| **Routines** | Saved instructions a bot runs daily at a time, every N minutes, once, or when a webhook is called. "Smart" routines only message you when there's something worth seeing. Bot-proposed routines need your approval. |
| **Sidebar** | Custom sections, hidden bots, unread badges, live status (working, waiting for approval, queued), ⌘K/Ctrl+K search, desktop notifications, light/dark themes. |

## Requirements

- **Node.js 18.17 or newer** (`node --version`)
- **Claude Code CLI**, installed and logged in (`claude --version`, then run `claude` once to sign in)
- macOS, Windows or Linux

## Run it

```bash
git clone <this repo> bullpen
cd bullpen
node server.js --open
```

Then open **http://127.0.0.1:4747** if a browser didn't open on its own.

- **Windows:** double-click `start.cmd`.
- **macOS:** double-click `start.command` (the first time, right-click → Open).

Options (flags or environment variables):

| Flag | Env | Default | |
|---|---|---|---|
| `--port` | `BULLPEN_PORT` | `4747` | Port to listen on |
| `--data` | `BULLPEN_DATA` | `./data` | Where everything is stored |
| `--host` | `BULLPEN_HOST` | `127.0.0.1` | Keep this unless you know why you're changing it. Bullpen has no login. |
| `--open` | | | Open the browser on start |
| | `CLAUDE_BIN` | auto | Path to the `claude` executable (also settable in Settings) |

## First steps

1. Your **Chief of Staff** bot is created on first run as the primary bot.
2. Click **＋** to add specialists. Give each a clear **What it does** line; teammates read it to decide who gets what. Point a bot at a **working folder** (for example one client's folder) so it works there.
3. Ask the Chief of Staff for something that needs a specialist. Watch the task card, the specialist's chat, and the report coming back.

Example setup for managing client accounts:

- **Chief of Staff** (primary) — routes work, follows up, keeps you posted.
- **Acme Account** — working folder `~/Clients/Acme`, instructions about that client's systems and contacts.
- **Globex Account** — same, for Globex.
- **Writer** — turns findings into client emails (as drafts you send yourself).
- A routine on each account bot: *weekdays at 8:30, check the folder for anything new and tell me only if it needs action.*

## How it works

```
Browser ⇄ Bullpen server (Node) ─ spawns per turn ─▶ claude -p --resume <bot session>
                ▲                                         │
                └──── loopback HTTP ◀── bullpen MCP server ┘  (team, cards, memory, skills, routines, approvals)
```

- **One turn** = one `claude -p --output-format stream-json` run in the bot's working folder that resumes the bot's session, with every waiting input for that chat batched in. Each input is labeled: `[From you]`, `[Task #12 from @chief]`, `[Report on task #12 …]`, `[Message from @x]`, `[Group chat …]`, `[Routine …]`.
- **Bullpen's tools** reach the bot through a small MCP server (`lib/mcp-server.js`) that Claude Code starts each turn. It forwards calls to the app with a per-turn token.
- **Approvals** use Claude Code's `--permission-prompt-tool`: when a bot wants to do something its permission level doesn't allow, Claude Code asks Bullpen, Bullpen shows you a card, and your answer goes back.
- **Long-running sessions:** Claude Code compacts long sessions on its own. When instructions, the team, memory or skills change, the bot gets a `[Context update]` on its next turn. If a session can't be resumed, Bullpen starts a new one with the bot's memory and a recap of the chat.
- **Isolation:** by default a bot loads only Bullpen's tools and its own extra MCP servers. Your personal Claude Code settings, allow-rules and connectors don't apply to it (`--strict-mcp-config --setting-sources project,local`). Turn on *Use my Claude Code settings and connectors* per bot to change that.

### Permission levels (per bot)

| Level | What the bot can do without asking |
|---|---|
| **Ask me** (default) | Read, search, web search/fetch, Bullpen tools. Everything else shows an approval card. |
| **Auto-edit** | Also edit files in its folder. Commands still need approval. |
| **Auto-review** | Claude Code's auto mode: a safety classifier allows routine actions and blocks risky ones. |
| **Read only** | Never edits or runs commands. |
| **Full access** | Anything, no prompts (`--dangerously-skip-permissions`). Only for folders you can afford to lose. |

"Always allow" on an approval card saves a Claude Code permission rule (for example `Bash(npm test)`) on that bot.

### Keeping bot-to-bot work in check

Bots that talk to bots can loop. Settings → Limits controls:

- **Bots working at once** (default 2). Each bot runs one turn at a time.
- **Turns per day** across all bots (300) and **per bot per hour** (40).
- **Turns per request chain** (30): the total bot turns one request can set off.
- **Hand-off limit** (4): how deep delegation and @mentions can nest.
- **Max steps per turn** (80) and **turn time limit** (30 min).
- A bot that fails three turns in a row is paused. The ⏸ button pauses everything.

## Data folder

```
data/
  config.json            settings
  bots/<id>/bot.json     a bot's profile, settings and session id
  bots/<id>/memory.md    its long-term memory
  bots/<id>/queue.json   inputs waiting for its next turn
  bots/<id>/workspace/   its default working folder
  channels/*.jsonl       chat history (append-only)
  shared/memory.md       shared memory
  skills/*.md            skills
  pages/                 Library pages
  files/                 uploads and attachments
  tasks.json, routines.json, rooms.json, usage.json
  trash/                 deleted bots and chats
```

Back it up like any folder. Stop Bullpen before restoring.

## Security notes

- Bullpen listens on `127.0.0.1` only, refuses requests addressed to any other host name (DNS-rebinding protection), and requires a custom header on every write so other websites can't drive it.
- There is no login. Anyone who can reach the port can use your bots. Don't expose it to a network you don't trust.
- Pages are served with a sandboxing Content-Security-Policy: no access to Bullpen or the network.
- Bots run with your user account's file access, limited by their permission level. Pick working folders deliberately.

## Development

```bash
npm test        # unit tests + end-to-end tests against a fake Claude CLI (no tokens used)
```

`test/fake-claude.js` mimics the CLI's stream-json output and session handling and drives the real MCP server, so delegation, approvals, cards, routines and group chats are tested end to end.

## License

MIT

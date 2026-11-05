# Bullpen

A local team of persistent AI bots, powered by the [Claude Code](https://docs.claude.com/claude-code) CLI.

You create bots, each with its own name, role, instructions, working folder, memory and chat, and talk to them like coworkers. One **primary bot** takes any request and hands the work to the right specialist. Specialists work in their own long-running conversations, **report back automatically**, and delegate to or message each other when they need to. Everything happens in one chat app on your own computer.

- **Zero dependencies.** Plain Node.js: no `npm install`, no database, no build step.
- **Light.** About 60 MB of memory and no CPU while idle; the whole interface is under 40 KB gzipped. The only heavy part is the Claude Code CLI during a turn, and you choose how many of those can run at once.
- **Local and private.** Runs on `127.0.0.1` behind an access key. Every chat, memory, page and routine is a plain file in one folder that only your account can read.
- **Uses your Claude Code login.** Each bot turn is a `claude -p` run that resumes that bot's session.

## What it does

| | |
|---|---|
| **Persistent bots** | Each bot keeps one Claude Code session going for weeks. When its context gets large, it saves notes to memory and starts a fresh session with a recap, so conversations can run indefinitely. |
| **Primary bot** | The default bot. Bring it anything: it delegates to specialists, checks what comes back, and gives you the result. |
| **Delegation with report-back** | `delegate_task` hands work to a teammate. Each task gets its own turn, and the teammate's reply goes back to the delegator automatically. The **Tasks** board tracks all of it. |
| **Group chats** | Several bots and you in one room. @mention a bot to call on it. Bots speak one at a time, in mention order, so each sees what the last one said, and they stay quiet when they have nothing to add. |
| **Needs you** | One inbox for everything waiting on you across all bots: approvals, questions, proposed routines and call-ins. |
| **Cards** | Question cards with clickable options, approval cards, draft cards for emails you send yourself, page cards, file cards and task cards. |
| **Approvals** | A bot reads its own folder freely, but editing files, running commands, reading elsewhere, or opening web pages needs your OK. "Always allow" is scoped to one command, one folder or one website. If you don't answer within a few minutes, the bot moves on and the card stays open; approving later gives the bot a new turn to finish. |
| **Memory** | Each bot has its own long-term memory, plus a shared memory every bot sees. Bots update it themselves; you can edit it, or pin any message to a bot's memory. |
| **Skills** | Reusable step-by-step procedures any bot can follow. Bots save new ones as they work things out. |
| **Pages** | Bots save reports, dashboards and trackers to your Library. They open beside the chat, sandboxed. |
| **Routines** | Saved instructions a bot runs daily at a set time, every N minutes, once, when a webhook is called, or **when files land in a folder**. "Smart" routines only message you when there's something worth seeing. Routines a bot proposes need your approval. |
| **Search and export** | Search every chat; export any chat to Markdown; download a backup of everything. |
| **Budgets** | Per-bot daily spending cap (API-equivalent cost) plus global limits on turns and hand-offs. |
| **Templates** | Start a bot as an account manager, researcher, writer, analyst or inbox triage, then edit it to suit. |

## Footprint

Measured with 10 bots and 36,000 messages (six months of history), on a Mac:

| | |
|---|---|
| Server memory, idle | about 60 MB |
| Server memory after opening all 10 chats | about 68 MB (only each chat's latest month is loaded) |
| Search across all 36,000 messages | about 20 ms |
| Browser page memory (JavaScript heap) | about 2–2.5 MB, even with 480 messages on screen |
| Switching to a 3,600-message chat | about 70 ms |

Each running bot turn adds one Claude Code process; *Bots working at once* (Settings → Limits) caps how many run together, and they run at low CPU priority.

## Requirements

- **Node.js 18.17 or newer** (`node --version`)
- **Claude Code CLI**, installed and signed in (`claude --version`, then run `claude` once to sign in)
- macOS, Windows or Linux

## Run it

```bash
git clone https://github.com/youngharold/bullpen
cd bullpen
node server.js --open
```

- **Windows:** double-click `start.cmd`.
- **macOS:** double-click `start.command` (the first time, right-click → Open).

The window shows a **sign-in link** with your access key. `--open` opens it for you, and the browser remembers the key after that. The key is also saved in `secret.json` in the data folder.

| Flag | Env | Default | |
|---|---|---|---|
| `--port` | `BULLPEN_PORT` | `4747` | Port to listen on |
| `--data` | `BULLPEN_DATA` | `~/.bullpen` | Where everything is stored |
| `--host` | `BULLPEN_HOST` | `127.0.0.1` | Leave this alone unless you know you need it |
| `--open` | | | Open the sign-in link in your browser |
| | `CLAUDE_BIN` | auto | Path to the `claude` executable (also in Settings) |

## First steps

1. Your **Chief of Staff** bot is created on first run as the primary bot.
2. Click **＋** to add specialists, or start from a template. Give each a clear **What it does** line: teammates read it to decide who gets what. Point a bot at a **working folder**, for example one client's folder.
3. Ask the Chief of Staff for something that needs a specialist, and watch the task card, the specialist's chat, and the report coming back.

An example setup for managing client accounts:

- **Chief of Staff** (primary): routes work, follows up, keeps you posted.
- **Acme Account**: working folder `~/Clients/Acme`, with instructions about that client's systems and contacts.
- **Globex Account**: the same, for Globex.
- **Writer**: turns findings into client emails, as drafts you send yourself.
- A folder routine on each account bot: *when files land in the client's Inbox folder, read them and tell me only if something needs action.*

## How it works

```
Browser ⇄ Bullpen (Node) ── one turn ──▶ claude -p --resume <bot's session>
              ▲                               │
              └──── MCP over loopback HTTP ◀──┘  (team, cards, memory, skills, routines, approvals)
```

- **One turn** is one `claude -p --output-format stream-json` run in the bot's working folder. It resumes the bot's session, with the waiting inputs for that chat batched in. Each input is labeled, for example `[From you]`, `[Task #12 from @chief]`, `[Report on task #12 …]`, `[Message from @x]`, `[Group chat …]` or `[Routine …]`.
- **Bullpen's tools** reach the bot over MCP. Bullpen itself serves them at `/mcp`, protected by a per-turn token, so a turn needs no extra helper process. A separate-process fallback is in Settings.
- **Approvals** use Claude Code's `--permission-prompt-tool`. Cards show everything they approve, in full; anything too large to review is refused. Claude Code stops waiting on a permission request after 5 minutes, so Bullpen answers within 4½. If you haven't decided by then, it tells the bot to move on, keeps the card open, and gives the bot a one-time permission for exactly that action when you approve.
- **Long conversations:** when instructions, the team, memory or skills change, the bot gets a `[Context update]` on its next turn. When its context passes the session limit (150k tokens by default), it saves notes and starts fresh with its memory and a recap of the chat.

### Permission levels (per bot)

| Level | What the bot can do without asking |
|---|---|
| **Ask me** (default) | Read and search inside its working folder, web search, and use Bullpen tools. Everything else shows an approval card. |
| **Auto-edit** | Also edit files in its folder. Commands still need approval. |
| **Auto-review** | Claude Code's auto mode: a safety classifier allows routine actions and blocks risky ones. |
| **Read only** | Never edits or runs commands. |
| **Full access** | Anything, with no prompts. Only for folders you can afford to lose. |

### Keeping bot-to-bot work in check

Bots that talk to bots can loop. Settings → Limits controls:

- **Bots working at once** (default 2). Each bot runs one turn at a time. On a crowded machine, set this to 1.
- **Turns per day** across all bots (300), and **per bot per hour** (40).
- **Turns per request chain** (30): the total number of bot turns one request can set off.
- **Hand-off limit** (4): how deep delegation and @mentions can nest.
- **Max steps per turn** (80) and **turn time limit** (30 minutes of working time).
- **Daily budget** per bot.
- A bot that fails three turns in a row is paused, and the ⏸ button pauses everything.

## Security

Bullpen is built for machines you share with other people and for bots that read content you don't control.

- **Access key:**
  - every request needs it, sent as a header from the browser's storage for this exact address;
  - other programs on other local ports can't see it, and there is no cookie to steal;
  - each page or file link carries its own signed token that opens only that one item and changes daily, the live update stream uses a separate read-only token, and exports and backups use one-time download tickets;
  - Settings → Security shows the key and makes a new one, which signs out every other browser.
- **Private data folder:**
  - the default is `~/.bullpen`, readable only by your account;
  - the backup download leaves out the access key.
- **Bots are isolated from your settings:**
  - they load no Claude Code settings files: not your personal allow-rules, and not rules a working folder ships in `.claude/settings*.json` (a downloaded folder could otherwise pre-approve commands);
  - your settings' `env` block, such as a proxy or gateway, is still passed through;
  - per bot, you can trust a folder's settings or use all of your own.
- **No silent data leaks:**
  - reading outside the working folder and opening web pages both need approval;
  - remote images in chat render as links, so displaying a message never contacts another site;
  - bot-made pages run sandboxed, with no network, no forms and no pop-ups.
- **Escalation guard:** a bot can't hand work to, or message, a bot with more permissions without your approval. A @mention of such a bot in a group chat becomes a "call in?" card. This stops a bot that was misled by something it read from getting a more powerful teammate to act for it.
- **Audit log:** approvals, permission changes, settings changes, failed sign-ins, webhooks and deletions, shown in Settings → Security.
- **Hardened server:**
  - a strict Content-Security-Policy, no framing, and DNS-rebinding protection;
  - writes from other sites are refused;
  - webhooks are rate-limited;
  - malformed requests can't crash the server.

## Data folder

```
~/.bullpen/
  config.json             settings
  secret.json             access key
  bots/<id>/bot.json      a bot's profile, settings and session id
  bots/<id>/memory.md     its long-term memory
  bots/<id>/queue.json    inputs waiting for its next turn
  bots/<id>/workspace/    its default working folder
  channels/<chat>/YYYY-MM.jsonl   chat history, one file per month
  shared/memory.md        shared memory
  skills/*.md             skills
  pages/                  Library pages
  files/                  uploads and attachments
  audit.jsonl             security events
  tasks.json, routines.json, rooms.json, usage.json, pending.json, deferred.json
  trash/                  deleted bots and chats
```

Only the most recent month of each chat is loaded into memory, and chats nobody has looked at for 10 minutes are dropped from memory, so months of history stay cheap. If you used an earlier version that kept data in `./data`, Bullpen keeps using that folder until you move it.

## Troubleshooting

- **"Claude Code CLI not found":** set its path in Settings → Bots & Claude, or start Bullpen with `CLAUDE_BIN` set.
- **Bots can't reach Claude at work, but `claude` works in a terminal:** company proxy or gateway settings sometimes live outside the settings `env` block. Turn on *Use my Claude Code settings and connectors* for that bot.
- **An older Claude Code can't connect to Bullpen's tools:** set Settings → Bots & Claude → Tool connection to *Separate helper process*.

## Development

```bash
npm test
```

This runs about 50 tests: unit tests, storage tests, end-to-end tests and shutdown tests. They use `test/fake-claude.js`, a stand-in for the CLI that speaks its stream-json format, keeps sessions, and calls Bullpen's real MCP endpoint. That covers delegation, approvals, cards, routines, group chats and security without spending any tokens.

## License

MIT

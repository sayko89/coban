# 🐑 Çoban

A persistent terminal server and attention queue for coding agents (Claude Code, Codex, OpenCode…).
Inspired by [Herdr](https://herdr.dev) (YC Fall 2026), rebuilt for the browser and extended.

Developers no longer run one agent at a time; they run several, across several projects. The hard part is
keeping track of which one is working, which one is waiting for your approval and which one is done.
Çoban keeps the terminals in its own server instead of the browser, reads every agent's screen to work out
its state, and only gets your attention when an agent actually needs you.

## Features

**The Herdr core**
- Persistent terminals: close the browser and the agents keep working; come back and the screen is where you left it.
- Resume after restart: if the server or the computer restarts, the layout comes back, the last screen contents are
  in the scrollback, and Claude Code, Codex and OpenCode continue the latest conversation in that folder
  (`claude --continue`, `codex resume --last`, `opencode --continue`).
- Workspaces and tabs: run the agent in one tab and the dev server in the tab next to it.
- Agent type and git branch: every tab shows which agent runs in it (claude, codex, opencode, gemini, cursor, copilot,
  aider…) and every workspace shows its git branch (`⎇ feat/charts * ↑1`). Agents started by hand are recognized from the screen.
- Agent state detection: **working**, **blocked** (waiting for approval), **done**, **idle**, **exited**.
- Attention queue: how many agents are waiting for you is always visible, and one key jumps to the next one.
- `coban` command-line tool: list agents, read their screens, send instructions, wait for a state.
  Agents can use it to hand work to each other (see below).

**What Çoban adds**
- **Herd view:** all agents as cards, each streaming the last lines of its terminal live. Approve a blocked agent
  right from its card without opening the terminal.
- **One-click approval:** approve or reject from the panel, a desktop notification or an email. For Claude Code, Codex
  and tools that ask `(y/n)`, Çoban sends the right keys.
- **Email notifications:** if an agent waits longer than a set time, you get an email. The link in it is single-use
  and stops working once the agent moves on.
- **Risky command warnings:** if the command awaiting approval is irreversible (`rm -rf`, force push, `DROP TABLE`,
  production deploys…), the approval bar turns red, approving takes two clicks, and the email subject changes.
- **Auto-approve rules:** rules like "always approve `npm test`". Risky commands are never auto-approved, even if they
  match a rule; Çoban skips the rule and warns you.
- **History and statistics:** how many approvals were requested today, how long agents waited, how many were answered
  by a rule and how much time that saved; a per-agent table and an event timeline.
- **Plugins:** extend Çoban with small JavaScript files in `plugins/`. Ships with four examples: daily report,
  done toast, long wait reminder and Discord notifications.
- **Four languages:** English, Turkish, German and Spanish. Pick one in the sidebar; the panel, the emails, the phone
  approval page, the bundled plugins and the demo agent all follow it. On first start Çoban uses the browser's language.
- A **demo agent** that needs no subscription.

| | Herdr | Çoban |
|---|---|---|
| Persistent terminals, reattach | ✓ | ✓ |
| Agent state detection | ✓ | ✓ |
| Interface | Terminal (TUI) | Browser |
| Workspaces, tabs | ✓ (tabs + split panes) | ✓ (tabs) |
| Agent type detection, git branch | ✓ | ✓ |
| Resume conversations after restart | ✓ (by session id) | ✓ (latest conversation in the folder) |
| Agents controlling each other (CLI) | ✓ | ✓ |
| Multiple machines (SSH) | ✓ | – |
| Remote approval | Attach over SSH, answer in the terminal | One click from an email |
| Risky command warnings | – | ✓ |
| Auto-approve rules | – | ✓ |
| History and statistics | – | ✓ |
| Plugins | ✓ (marketplace) | ✓ (folder based) |
| Interface languages | English (docs in 3 languages) | English, Turkish, German, Spanish |

## Installation

1. Install [Node.js 22 LTS](https://nodejs.org).
2. Open a terminal in the project folder:
   ```
   npm install
   npm start
   ```
3. Open `http://localhost:4800` in your browser.

Works on Windows, macOS and Linux. On Windows, terminals open in PowerShell.

## Quick tour

1. Click **Open demo agent**, type a task and press Enter.
2. While it runs the sidebar shows **working**; when it asks a question the approval bar appears at the top.
3. Close the browser tab and open it again: the screen is where you left it.
4. On the third task the demo agent asks to run `rm -rf` with a force push: see the risky command warning.
5. On the **Auto-approve** page add a rule for `npm run deploy` and give the agent a new task: it is approved on its own.
   Try the same for `rm -rf`: the rule is not applied.
6. Open the **History** page for a summary of what happened.
7. In the terminal view click **+ Tab**, name it `server` and run something like `ping localhost -t` next to the agent.

## The `coban` command-line tool

The `coban` command works in every Çoban terminal without installing anything. To use it elsewhere, run
`node bin/coban.js …` in the project folder, or run `npm link` once and then type `coban …`.

```
coban list                                     # all agents, their state, type and git branch
coban read demo-agent-1 --lines 30             # the last 30 lines of its screen
coban send demo-agent-1 "write tests" --wait   # send an instruction, wait until it finishes or asks for approval
coban wait demo-agent-1 --until blocked        # wait until the agent asks for approval
coban approve demo-agent-1                     # approve the pending question (reject works too)
coban keys demo-agent-1 esc                    # send keys: enter, esc, tab, up, down, ctrl+c…
coban start reviewer --command claude          # open a new tab (in the same workspace if run inside Çoban)
coban close reviewer
```

While an agent is waiting for approval, `send` refuses to type (so the text doesn't accidentally answer the question);
use `--force` to send it anyway. Every command accepts `--json` for machine-readable output. Inside a Çoban terminal,
`.` as the agent name means the tab running the command.

**Agents handing work to each other.** You can tell an agent: "Open a helper with `coban start reviewer --command claude`,
give it work with `coban send reviewer "review the latest changes" --wait`, then read its answer with
`coban read reviewer --lines 80` and summarize it for me." The agent runs these commands in its own terminal and
manages the second agent itself.

## Writing a plugin

Add a `.js` file to the `plugins/` folder and restart Çoban:

```js
module.exports = {
  name: 'Hello',
  description: 'Shows a message in the panel when an agent finishes.',
  start(coban) {
    coban.on('done', event => coban.toast(`${event.agent} finished!`));
  },
};
```

| Event | When |
|---|---|
| `approval-requested` | An agent asks for approval (with `risky` and `riskLine` fields) |
| `answered` | An approval is given or rejected (`source`: panel, email, auto, cli) |
| `done` | An agent finishes its task |
| `exited` | A terminal process exits |
| `state` | Every state change |
| `created`, `removed` | A tab is opened / closed |
| `sent` | An instruction is sent from the CLI or a plugin |

Tools on the `coban` object: `toast(text, kind)`, `send(agentName, text)`, `sessions()`, `every(seconds, fn)`,
`setStatus(text)`, `log(text)`, `config` (from `plugins.<file name>` in config.json), `dataDir`.

## Keyboard shortcuts

| Keys | Action |
|---|---|
| `Alt` + `↑` / `↓` | Switch between all tabs |
| `Alt` + `←` / `→` | Switch between tabs in the same workspace |
| `Alt` + `T` | New tab in this workspace |
| `Alt` + `J` | Jump to the next agent waiting for approval |
| `Alt` + `S` | Back to the herd view |

## Email notifications

1. Turn on 2-Step Verification in your Google account, then create a password on the
   [App passwords](https://myaccount.google.com/apppasswords) page.
2. Copy `config.example.json` to `config.json` and fill in your address and the app password.
3. Restart the server and try the **Test email** link in the panel.

If your phone is on the same Wi-Fi as the computer, the buttons in the email work directly. If the Windows
firewall asks for permission, allow **private networks**.

| `config.json` field | Default | Description |
|---|---|---|
| `approval.waitSeconds` | `20` | How long an agent has to wait for approval before an email is sent |
| `approval.port` | `4801` | Port of the approval pages |
| `approval.url` | your local network IP | Address used in email links (put your tunnel's address here if you use one) |
| `screenHistory` | `true` | Save screen contents under `data/screens/` and bring them back after a restart. Terminal output can contain secrets; set to `false` if you don't want that |
| `resumeAgents` | `true` | Resume Claude Code, Codex and OpenCode from their latest conversation after a restart |
| `plugins.<name>` | – | Settings for a plugin, e.g. `"plugins": { "discord": { "webhook": "…" } }` |
| `language` | browser's language | Default language (`en`, `tr`, `de`, `es`) until one is picked in the panel |

## Languages

Pick a language from the **Language** menu at the bottom of the sidebar. The choice is saved on the server
(`data/ui.json`), so emails and the phone approval page are written in the same language. You can also set a default
in `config.json` with `"language": "tr"`.

What follows the language: the whole web panel, error messages, risky command labels, emails, the approval page,
the bundled plugins and newly started demo agents. What stays English: the `coban` command-line tool (it is meant for
scripts and agents) and the server's console output. A demo agent that is already running keeps the language it was
started in; open a new one after switching.

**Adding a language.** All texts live in one file, `public/i18n.js`, which both the browser and the server use.
Copy the `en` block, translate the values, give it a code (for example `fr`) and add it to `LANGUAGES` at the top.
Missing keys fall back to English, so you can translate gradually. Plugins can be translated too: `name`,
`description`, `setStatus()` and `toast()` accept an object such as `{ en: 'Daily report', tr: 'Günlük rapor' }`,
and `coban.language` tells a plugin which language the user picked.

## Architecture

```
 Browser (xterm.js) ──WebSocket──┐
                                 │      ┌─ PowerShell / bash ── agent (claude, codex…)
                      ┌──────────┴───┐  │
 coban CLI ──HTTP─────│ Çoban server │──┼─ PowerShell / bash ── dev server
                      │  :4800       │  │
                      └──┬───────┬───┘  └─ …
                         │       │
         invisible xterm │       │ approval server :4801
        (reads the screen│       │ (single-use approval
         works out state)│       │  pages only)
                         ▼       ▼
                    status.js  notifier.js ── Gmail
```

| File | Role |
|---|---|
| `server.js` | Terminal sessions, API, WebSocket, approval server |
| `status.js` | Screen reading, state detection, risky command patterns |
| `agents.js` | Agent type detection, resume commands |
| `git.js` | Git branch and status |
| `rules.js` | Auto-approve rules |
| `history.js` | Activity history and statistics |
| `plugins.js` | Plugin loader; example plugins in the `plugins/` folder |
| `notifier.js` | Email delivery |
| `errors.js` | Errors with codes, so the panel can show them in the user's language |
| `public/i18n.js` | All texts in every language, shared by the panel and the server |
| `bin/coban.js` | `coban` command-line tool |
| `public/` | Web panel (`index.html`, `style.css`, `app.js`, `i18n.js`) |
| `demo-agent.js` | Demo agent for demos and testing |

## Security

- The panel is only reachable from this computer by default (`127.0.0.1`). The panel gives full terminal access;
  think twice before exposing it with `HOST=0.0.0.0`.
- Approval pages run on a separate port and give no terminal access; they can only answer the question that is
  pending right now.
- The link in an email never answers by itself; it opens a confirmation page first. Some mail apps open links
  automatically to build previews; if the link answered directly, an agent could be approved without you looking.
- `config.json` is in `.gitignore`, so your app password is not pushed to GitHub.

## Limitations

- Resuming opens the **latest** conversation in that folder. If two Claude tabs share a folder, both return to the
  same conversation; Herdr solves this with official integrations that read each agent's session id.
- There are no split panes (two terminals on one screen), only tabs. Connecting multiple machines is not supported.
- If the computer goes to sleep, the terminals stop too. For long jobs keep the computer awake or run Çoban on a server.
- State detection relies on the text on screen; for question formats it doesn't recognize, the agent shows as
  **blocked** but no buttons appear, and you answer in the terminal.

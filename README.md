# Pi extensions

Extensions for [Pi](https://pi.dev), the terminal coding agent, that bring over
what Claude Code does: Pi runs Claude models on your Claude subscription, shows
a status line with the subscription limits, searches and reads the web, keeps a
memory per project as Claude Code does, titles every session and lights up its
tmux tab while it works, lets sessions message each other, brings over Claude
Code's subagents, questions, side questions, loops, scheduled prompts, diff
view, agent panel, and Remote Control for the Claude app, reads and changes
OpenProject and GitLab, controls your Chrome, keeps requests alive through
network trouble, continues after a usage limit resets, keeps long conversations
small, waits for pipelines and deploys without spending requests, keeps itself
and the Claude Agent SDK current.

Install it as a Pi package (step 3 of the setup below): its `package.json`
names `extensions/`, which holds one file per extension.

| Extension                   | What it does                                                                              | Needs                                                            |
| :-------------------------- | :---------------------------------------------------------------------------------------- | :--------------------------------------------------------------- |
| `statusline.ts`             | Replaces Pi's footer with a Claude Code style status line, for any provider               | —                                                                |
| `compact-tools.ts`          | Cuts each collapsed tool row to one line with its count and time; Ctrl+O shows all        | —                                                                |
| `web-tools.ts`              | Adds `web_fetch`: reads a page locally and lets a small model answer from it              | —                                                                |
| `openproject.ts`            | Adds `openproject`: reads and changes OpenProject through its API v3, as you              | An OpenProject API token for each instance                       |
| `gitlab.ts`                 | Adds `gitlab`, `gitlab_pipeline`, `gitlab_work`: GitLab's API as you, CI and issues brief | A GitLab personal access token for each instance                 |
| `onepassword.ts`            | Adds the `onepassword_*` tools: 1Password items and `op run`, one approval per session    | The 1Password CLI, signed in through the 1Password app           |
| `vault.ts`                  | Adds the `vault_*` tools: HashiCorp Vault KV secrets, commands with secrets, OIDC login   | `VAULT_ADDR`; the `vault` CLI for `vault_login`                  |
| `drupal-org.ts`             | Adds `drupal_org`: drupal.org's web UI as you, in a Chrome profile of its own             | Chrome or Chromium; one sign-in with `/drupal-org login`         |
| `memory.ts`                 | Keeps a memory per project, shared with Claude Code's auto memory when it is there        | —                                                                |
| `session-title.ts`          | Names each session after its first prompt and shows it in the terminal title              | —                                                                |
| `tmux-tab-activity.ts`      | Turns Pi's spinner in its tmux tab while Pi or a subagent works                           | tmux 3.2 or later, set up as its section describes               |
| `session-socket.ts`         | Lets sessions message each other and your Claude Code sessions, as Claude Code does       | Linux or macOS                                                   |
| `ask-user-question.ts`      | Adds `ask_user_question`, Claude Code's multiple-choice questions                         | —                                                                |
| `subagents.ts`              | Adds the `agent` tool: subagents in their own Pi process, on a tier or a model of choice  | —                                                                |
| `btw.ts`                    | `/btw`: a side question about the session that stays out of the conversation              | —                                                                |
| `scheduled-tasks.ts`        | `/cron` and the cron tools: prompts on a schedule within the session                      | —                                                                |
| `diff.ts`                   | `/diff`: a panel beside the conversation with the changes and each turn's edits           | git                                                              |
| `background-agents.ts`      | The agent panel below the prompt: ↓ to the agents, Enter opens one, Ctrl+B to background  | `subagents.ts`                                                   |
| `network-resilience.ts`     | Claude Code's handling of dropped connections: stall notice, restart, network wait        | —                                                                |
| `auto-continue.ts`          | Waits out a used-up usage limit, quota, or rate limit and continues after the reset       | —                                                                |
| `idle-compaction.ts`        | Summarises an idle conversation in the background; used once the prompt cache expired     | —                                                                |
| `compaction-cut.ts`         | Cuts a compaction where measured tokens reach the kept part, not where Pi estimates it    | —                                                                |
| `compact.ts`                | Adds `compact`: the model compacts the session on its own and then continues the task     | —                                                                |
| `wait.ts`                   | Adds `wait`: checks a command or tool until a condition holds, without model requests     | —                                                                |
| `bash-timeout.ts`           | Stops a bash call without its own timeout after two minutes, as Claude Code does          | —                                                                |
| `package-update.ts`         | Keeps this package current, and reloads Pi when it changes                                | The package installed with `pi install`                          |

**Claude Code's formats, any model** (`claude-code-*`). They read Claude Code's
agent definitions and run them in Pi, whichever model answers.

| Extension                   | What it does                                                                              | Needs                                                            |
| :-------------------------- | :---------------------------------------------------------------------------------------- | :--------------------------------------------------------------- |
| `claude-code-agents.ts`     | Adds Claude Code's agent definitions, tool names, and model families to `agent`           | `subagents.ts`                                                   |

**The Claude subscription** (`claude-*`). They need Pi's Anthropic login on a
Claude subscription (`/login`) and show nothing without one; Remote Control
connects only while a Claude model is active.

| Extension                   | What it does                                                                              | Needs                                                            |
| :-------------------------- | :---------------------------------------------------------------------------------------- | :--------------------------------------------------------------- |
| `claude-usage.ts`           | Adds the Claude subscription limits and usage credits to the status line                  | `statusline.ts`, Pi's Anthropic login                            |
| `claude-remote-control.ts`  | `/remote-control`: drive the session from the Claude app and claude.ai/code               | A Claude model on Pi's Anthropic login, `pi-claude-agent-sdk`    |

**The claude-bridge provider** (`claude-sdk-*`). They work on
`pi-claude-agent-sdk` and do nothing without it.

| Extension                   | What it does                                                                              | Needs                                                            |
| :-------------------------- | :---------------------------------------------------------------------------------------- | :--------------------------------------------------------------- |
| `claude-sdk-prices.ts`      | Gives the claude-bridge models Anthropic's list prices, so replies show what they cost    | `pi-claude-agent-sdk`                                            |
| `claude-sdk-rules.ts`       | Passes Pi's rules, the guidelines of the tools among them, on to Claude Code              | `pi-claude-agent-sdk`                                            |
| `claude-sdk-stream-only.ts` | Keeps Claude Code on streamed responses, so a stalled one cannot leave Pi waiting         | `pi-claude-agent-sdk`                                            |
| `claude-sdk-update.ts`      | Installs a newer Claude Agent SDK, and with it Claude Code, as soon as there is one       | `pi-claude-agent-sdk`, npm                                       |

Every extension is a single file that works on its own. Code that several of
them need — the [small model](#small-model) choice, the overlay frame,
Claude Code's tool names, the instances and tokens of `gitlab.json` and
`openproject.json`, the lookup of Pi's Anthropic login — is copied into each of
them, with a note that names the other copies. What one extension does for
others while Pi runs goes through Pi's event bus instead:
[claude-usage](#claude-usage) hands the plan limits to
`claude-remote-control.ts`, which goes without them when that file is missing.
`web_search` comes from the npm package `pi-web-access`; see
[Web search](#web-search).

## Set up Pi

Follow the steps in order — together they are the complete setup: Pi itself,
the Claude subscription, all thirty-two extensions, and the browser
connection. Every step except the Chrome switch in step 4 is a shell command,
so an agent can carry them out as well.

What you need first:

- A Claude subscription (Pro or Max); step 2 signs Pi in to it. Claude Code
  itself need not be installed: the provider brings its own
- Google Chrome 144 or newer, for the browser connection

### 1. Install Pi

The official guide is Pi's [Quickstart](https://pi.dev/docs/latest/quickstart);
it also covers Windows, Android, and installing from npm or Nix. On macOS and
Linux, the installer is one command:

```bash
curl -fsSL https://pi.dev/install.sh | sh
pi --version
```

The installer pins Pi's dependencies and can install Node.js 22.19 or newer,
which Pi needs. `pi update` updates Pi later. The Quickstart's "Choose a
model" step (`/login`) is part of step 2 below, which connects Pi to your
Claude subscription.

### 2. Run Claude on your subscription

```bash
pi install npm:pi-claude-agent-sdk
```

The package runs Claude models through Claude Code on Pi's own Anthropic
login, so requests count against your subscription, not API billing. Sign Pi
in once: start `pi`, run `/login`, and pick Anthropic (Claude Pro/Max). Pi
keeps the login in `~/.pi/agent/auth.json`, renews it by itself, and hands it
to every Claude Code process the package starts; a Claude Code login of its
own is not needed. Make the provider the default in
`~/.pi/agent/settings.json`, next to the `packages` entry the install wrote:

```json
{
  "defaultProvider": "claude-bridge",
  "defaultModel": "claude-opus-5-5",
  "packages": ["npm:pi-claude-agent-sdk"],
  "compaction": {
    "reserveTokens": 32768,
    "modelOverrides": {
      "claude-bridge/claude-opus-5-5": { "reserveTokens": 700000 },
      "claude-bridge/claude-opus-5": { "reserveTokens": 700000 },
      "claude-bridge/claude-sonnet-5-5": { "reserveTokens": 700000 },
      "claude-bridge/claude-sonnet-5": { "reserveTokens": 700000 },
      "claude-bridge/claude-haiku-5-5": { "reserveTokens": 700000 },
      "claude-bridge/claude-fable-5-2": { "reserveTokens": 700000 },
      "claude-bridge/claude-fable-5-1": { "reserveTokens": 700000 },
      "claude-bridge/claude-fable-5": { "reserveTokens": 700000 }
    }
  },
  "retry": { "maxRetries": 10, "maxAgentDelayMs": 32000 }
}
```

`/model` in Pi switches to another `claude-bridge/…` model.

The `compaction` reserve makes Pi compact before Claude Code refuses the
request. With its own auto-compaction off, Claude Code blocks locally at the
context window minus 23k tokens, so at 977k for a 1M model, and answers
"Prompt is too long". Pi's default reserve of 16384 tokens would only start
compacting at 983,616. Pi does recover from the error by compacting and
retrying, but the turn fails first.

The `modelOverrides` make the models with a 1M context window compact at
300k tokens instead (1M minus 700,000). Every request reads the whole context
again, so a session that grows towards 1M costs most: requests above 150k
were a quarter of all and caused well over half of the cost. 300k, raised
from 150k, pays for the requests between the two and in return compacts half
as often, so fewer details of a long session are lost to the summary. A model
with a smaller window must not get such an override, since its threshold would
fall below zero and Pi would compact before every request.

The `retry` values let Pi retry a dropped connection or an overloaded server
ten times, after 2, 4, 8, 16, then 32 seconds, as Claude Code retries ten
times; Pi's default gives up after three tries within 14 seconds.
[network-resilience](#network-resilience) adds what Pi lacks: the notice
while a response hangs, the restart of a silent request, and the wait while
the network is down.

The package pins the Claude Agent SDK, and with it Claude Code, to one
version, and only a release of the package moves it. `claude-sdk-update.ts`
from step 3 keeps it current, so that Claude Code knows the newest models; see
[claude-sdk-update](#claude-sdk-update).

### 3. Install the extensions

Install this repository as a Pi package:

```bash
pi install git:github.com/dandjo/pi.dev-extensions
```

Pi clones it into `~/.pi/agent/git/` and loads all thirty-two extensions
from there; `pi list` shows the package. [package-update](#package-update)
brings new versions at every start, new and renamed extensions included, and
reloads Pi once it is idle; `/update` fetches them at once. There is no build
step and no `npm install`: the extensions import only packages Pi provides
itself. Each file stands on its own; `pi config` turns single ones off.

Then add web search, pinned to the tested version, and configure it as
[Web search](#web-search) describes:

```bash
pi install npm:pi-web-access@0.44.0
```

For OpenProject, set the instance and your API token as
[openproject](#openproject) describes.

For GitLab, set the instance and your access token as [gitlab](#gitlab)
describes.

### 4. Connect your Chrome

In Chrome, open `chrome://inspect/#remote-debugging` and allow incoming
debugging connections. This is the one step only you can do.

Then register Chrome DevTools MCP with Pi:

```bash
pi mcp add chrome-devtools -- npx -y chrome-devtools-mcp@latest --autoConnect --no-usage-statistics --no-performance-crux
```

`pi mcp add` has no option for how the model reaches the tools, so add
`"exposure": "deferred"` to the entry it wrote in `~/.pi/agent/mcp.json`, or
change it under `/mcp` in Pi. The entry then reads:

```json
{
  "mcpServers": {
    "chrome-devtools": {
      "command": "npx",
      "args": ["-y", "chrome-devtools-mcp@latest", "--autoConnect", "--no-usage-statistics", "--no-performance-crux"],
      "exposure": "deferred"
    }
  }
}
```

`pi mcp list` must now report `chrome-devtools: connected, 32 tools (deferred, global)`.
On the first browser action, Chrome asks whether to allow the connection —
choose **Allow**. What the connection can see and why it is set up this way:
[Browser control](#browser-control).

Playwright MCP adds a headless browser of its own, for pages that need
JavaScript but no login. Register it the same way, and add
`"exposure": "deferred"` to its entry as well:

```bash
pi mcp add playwright -- npx -y @playwright/mcp@latest --headless --isolated --output-dir "~/.cache/playwright-mcp"
```

```json
"playwright": {
  "command": "npx",
  "args": ["-y", "@playwright/mcp@latest", "--headless", "--isolated", "--output-dir", "~/.cache/playwright-mcp"],
  "exposure": "deferred"
}
```

`pi mcp list` then reports `playwright: connected, 25 tools (deferred, global)`.
It starts the installed Google Chrome; without one, see
[Browser control](#browser-control).

### 5. Check the result

Start Pi in a project, or run `/reload` in a running session:

- The footer shows the status line with your subscription limits.
- "Search the web for …" answers through `web_search`.
- "Read https://… and tell me …" answers through `web_fetch`.
- "Which statuses does OpenProject have?" answers through `openproject`.
- "Which GitLab merge requests are assigned to me?" answers through `gitlab`.
- A few seconds after the first prompt, the terminal title reads
  `π - <session title> - <directory>`.
- With Pi running in a second terminal, `/peers` lists that session, and
  "Send the other session a hello" shows up there as `› Message from @…`.
- "Ask me with ask_user_question whether I prefer tea or coffee" shows a
  question dialog.
- "Use an Explore subagent to find where the session title is set" runs a
  subagent; `/agents` lists the agent types.
- "Run `sleep 60` in a background agent" shows the agent panel below the
  prompt; ↓ selects it and Enter opens the agent's transcript.
- "Run `sleep 60` in a subagent" lists the foreground agent in the panel as
  well; Ctrl+B moves it to the background, and its report arrives later.
- `/btw what was my first request?` answers in an overlay.
- `/diff` in a git project opens the diff panel beside the conversation.
- `/rc` shows a link and a QR code, and the session appears under Code in the
  Claude app; a message sent from there arrives in the terminal.
- "Open example.com in the browser" opens a tab in your Chrome.
- "Open example.com with Playwright and tell me its title" answers through
  `browser_navigate`, without a window.

## Manage extensions

`pi config` enables or disables each extension individually. To try one for a
single run without installing it, with the path of its file in a clone of this
repository:

```bash
pi -e ./extensions/web-tools.ts
```

To turn an extension off, disable it in `pi config` and `/reload`.
`pi remove git:github.com/dandjo/pi.dev-extensions` removes them all.
`pi remove npm:pi-web-access@0.44.0` removes web search.
`pi mcp remove chrome-devtools` removes the browser connection.

## Another provider

Every extension loads with any provider, and a model switch within a session
needs nothing. What changes with a provider other than Claude:

- The groups of the extension table tell what keeps working: all but the
  Claude subscription and the `claude-bridge` provider groups.
  `claude-usage.ts` shows nothing without Pi's Anthropic login on a Claude
  subscription, `claude-remote-control.ts` connects only while a Claude model
  is active, and the `claude-sdk-*` files do nothing without
  `pi-claude-agent-sdk`.
- Subagents name a tier: `small` and `large` resolve on the current provider,
  `Explore` runs on `small`, and a Claude family the provider lacks (`haiku`
  elsewhere) falls back to its tier. `~/.pi/agent/subagents.json` names the
  model of a tier per provider where the automatic choice does not fit; see
  [subagents](#subagents).
- Values that follow Claude's prompt cache can be set per provider:
  `cacheWarmMinutes` in [network-resilience](#network-resilience), and
  `prepareMinutes` and `coldMinutes` in [idle-compaction](#idle-compaction).
- An extension for another subscription's limits adds status line rows of its
  own and offers the limits to other extensions as `claude-usage.ts` does,
  through `plan-usage:source` (see [claude-usage](#claude-usage)).
- The memory follows `memory.json`. When the folder in use is empty after a
  switch, Claude Code removed for one, `/memory migrate` copies the project's
  entries over (see [memory](#memory)).

## package-update

Keeps this package of extensions current. It needs nothing from any provider.

- The package is the one `pi install` put this file in. Every other installed
  package stays as it is until `pi update` by hand; `pi-web-access` is pinned
  on purpose, and [claude-sdk-update](#claude-sdk-update) keeps the Claude
  Agent SDK of `pi-claude-agent-sdk` current.
- At every Pi start (not with `PI_OFFLINE` set), the package is brought up to
  date in the background with
  `pi update <package>`, as by hand, but in a separate process, so its output
  stays out of the terminal, and git never asks for a password: SSH runs in
  batch mode. One Pi process updates at a time; one started meanwhile waits
  for it and uses its result. A local folder is not updated, and subagent
  processes ([subagents](#subagents)) update nothing.
- When an update changed what the package loads into Pi (`package.json` and
  the extensions, skills, prompts, and themes it names), Pi reloads by itself,
  so the new extensions and skills
  apply without a restart. Commits that change only other files update the
  package without a reload.
- The reload waits until Pi is at rest in the terminal: no response or
  compaction running, nothing queued, no prompt just submitted, and the empty
  prompt editor in focus. An open selector such as `/resume` or `/model`, a
  dialog, or a half-typed prompt is never interrupted. Until then
  `<package> updated <old> -> <new>; Pi reloads once it is idle.` tells that
  the previous version is still loaded. Outside the terminal (RPC mode) the
  notice asks for `/reload` instead.
- `/update` updates the package and reloads at once.
- After the reload, its own or the one Pi makes by itself, a line tells the
  result: `<package>: updated <old> -> <new>; reloaded.`, or
  `<package>: already current (<revision>); reloaded.`. It takes the place of
  Pi's own `Reloaded …` line, since a reload draws the conversation anew and a
  notice shown before it would be gone.

## statusline

Replaces Pi's footer in the interactive terminal with the lines of
[claude-code-cli-status-line](https://github.com/dandjo/claude-code-cli-status-line),
the same status line for Claude Code: model with its thinking level, working
directory, git branch, context-window usage, tokens, session cost, and elapsed
time, for any provider. Below them come the rows other extensions add —
[claude-usage](#claude-usage) adds the subscription limits — and the statuses
that other extensions set appear as a last line.

The session name stands in the line above the prompt, as in Claude Code's
prompt box, set in from the right end as far as Pi sets in the working status
from the left: `── ⠋ Working ──── … ──── <name> ──`. It is the name
[session-title](#session-title) gives the session, or the one set with `/name`
or `--name`, cut with `…` to half the width. It changes as soon as the name does, and stays away while a session has
none. Every prompt editor draws it, Pi's own and the one
[background-agents](#background-agents) sets, because the extension hooks
`renderTopBorder` of Pi's `CustomEditor` class. That method is not a
documented extension interface: when a Pi update removes it, the name is
simply not shown.

An extension adds rows through the event bus: it emits `statusline:section`
with an `id` and a `render(theme)` that returns the rows, at load and again on
every `statusline:section-request`, so the load order does not matter.
`statusline:changed` asks for a render. Sections appear in the order of their
ids; `render` runs at every render and must return at once.

In fullscreen mode a click on a status in the last line emits
`statusline:status-click` with its key; the extension that set the status
decides what happens. A click on `↻ … scheduled` opens the
[task manager](#scheduled-tasks), one on `↓ to manage` moves into the
[agent panel](#background-agents).

## claude-usage

Adds the Claude subscription limits to the [status line](#statusline): the
subscription windows (`5h`, `7d`, and model-scoped weekly windows such as
Fable) with their reset times, and the usage credits while they are enabled or
anything was spent. Without `statusline.ts` it does nothing.

The limits come from `api.anthropic.com/api/oauth/usage`, the endpoint of
Claude Code's `/usage` dialog, asked in the background and only while the
status line shows them or [Remote Control](#claude-remote-control) needs
them. The endpoint is rate-limited per account, so all Pi
sessions share one answer through `~/.cache/pi-statusline/usage.json`: one
session at a time asks, at most every five minutes, and the others read the
file, so a new session shows the limits right away. The access token is
Pi's own Anthropic login (`/login`, Anthropic (Claude Pro/Max)), the one the
`claude-bridge` provider runs on, as Pi hands it to extensions: Pi renews a
token that ran out before it hands it over, also after hours without a prompt.
The token is never refreshed here and never written to the cache.

Between the fetches, every response of the providers `claude-bridge` and
`anthropic` updates the `5h` and `7d` rows from its
`anthropic-ratelimit-unified-*` headers, which `pi-claude-agent-sdk` rebuilds
from Claude Code's rate-limit events, and the shared answer with them, so the
rows follow each response. The fetches stay for the start, for idle times, and
for what the headers lack: the model-scoped windows and the usage credits.
After `/login` with another account the rows follow it with the next response
and the next fetch.

Without Pi's Anthropic login there are no rows and no requests, and neither
with an Anthropic API key, which has no plan limits: someone on another
provider sees nothing of this. While the session's model is not a Claude
model — any model of the providers `claude-bridge` and `anthropic`, elsewhere
one with `claude` in its id — or the session has none, the rows are hidden as
well. The limits are still
fetched then, so they stand there as soon as a Claude model is chosen again.
With `PI_OFFLINE` set (Pi's `--offline`), the rows show what another
session fetched last, and this one fetches nothing. Reset times, dates, and
credit amounts follow `LC_TIME` and `LC_MONETARY` (or `LC_ALL`, else `LANG`),
as other programs on the machine do: `Di., 10.11., 13:28` and `$ 12,34` under
`de_AT`, `Tue, 11/10, 01:28 PM` and `$12.34` under `en_US`. Node's own default
reads `LANG` alone.

Other extensions get the answer through Pi's event bus, in a protocol that
names no provider: `plan-usage:source` carries a source with the plan's id
(`claude`), the models its limits apply to, the latest answer, and a refresh
under the same five-minute rule; `plan-usage:changed` with the id follows every
new one. `claude-remote-control.ts` hands the limits to the Claude app that
way, and an extension for another subscription's limits can offer them alike.

Without an answer from the last hour, a single `Limits` line takes the place
of the limit lines and says why. A warning ends in `· next try 23:52`, the
time of the next attempt.

| Shown as                    | Cause                                      |
| :-------------------------- | :----------------------------------------- |
| `loading…`                  | The first answer is on its way             |
| `⚠ rate limited (HTTP 429)` | The endpoint turned the request away       |
| `⚠ no valid login: /login`  | Pi could not hand out its Anthropic login: its renewal failed |
| `⚠ no Claude subscription login: /login` | The login went away since the last check (`/logout`) |
| `⚠ HTTP 401`                | The endpoint rejected the token            |
| `⚠ endpoint unreachable`    | Offline, or no answer within 10 seconds    |

## compact-tools

Cuts each collapsed tool row to one line and leaves everything else as Pi
draws it:

```
$ cat big.txt                                            30 lines · 0.0s
$ ls /nonexistent                               exit 2 · 1 line · 0.0s
ls: cannot access '/nonexistent': No such file or directory
edit src/index.ts                                          +2 −1 · 0.0s
```

- The row is the call as the tool draws it, its first line cut to fit, and on
  the right how many lines the result has and how long the tool ran; while it
  runs, the time counts up. An edit shows the lines it added and removed.
  Pi's padding lines above and below the row go too; the background keeps
  Pi's colours for running, done, and failed.
- A failed tool shows its count in the error colour, a shell command its exit
  code, and below the row the last line of its output.
- A call that hands its work to the background (`wait`, `gitlab_pipeline`,
  `agent`) shows its id on the right instead (`→ w4`), and the time only when
  it waited here first.
- Ctrl+O, or in fullscreen mode a click on the row, shows the row in full, as
  Pi does.
- `{"lines": n}` in `~/.pi/agent/compact-tools.json` with n of 2 or more keeps
  up to n lines instead: a row that fits stays as Pi draws it, a longer one
  first loses its blank lines, then shows its first lines (shell output its
  last ones, as Pi's preview does) and how many lines are hidden. The file is
  read at load, so `/reload` applies a change.
- `codemode` keeps Pi's row as it is: its own preview already limits the
  script, its calls, and its output.
- It covers Pi's tools, those of other extensions, and MCP tools, through
  `pi.registerToolRenderer()`. What the model sees does not change, and
  nothing is stored.

## web-tools

Registers `web_fetch` as a tool the model can call. It fetches the page from
your machine, turns its main content into Markdown, and lets the
[small model](#small-model) answer the call's prompt from it. Only that answer
enters the conversation, not the page.

- The request comes from your machine and network, VPN included, with the agent
  string `pi-web-fetch/1.0`. Many sites behind Cloudflare (docs.moodle.org,
  Stack Overflow, npm, raspberrypi.com) answer every client that is not a real
  browser with a bot challenge (`cf-mitigated: challenge`), whatever its agent
  string. The tool then reads the page's latest raw capture from the
  [Wayback Machine](https://web.archive.org/) instead and puts its date and
  address above the answer; only the page's address goes to archive.org.
  `{"waybackFallback": false}` in `~/.pi/agent/web-tools.json` turns that off.
  Other blocks (Reddit), and a challenged page without a capture, end in an
  error that points to a browser tool.
- That pointer names a browser tool that runs a browser of its own, such as
  Playwright, rather than one attached to your browser, which is for pages
  that need your login. It also comes with a Wayback Machine capture (for
  when the page must be current), with a page without text, and above a page
  that has scripts but less than 300 characters of text without them, which
  is likely built by JavaScript. Whether the model then opens a browser is
  its choice; `web_fetch` never does.
- Redirects within the same site are followed. A redirect to another site is
  reported, and the model decides whether to fetch the target.
- Text pages only: HTML, plain text, JSON, XML. PDFs and other files are refused
  with a hint to use `curl`. A body is cut at 10 MB, the page at 100,000
  characters before it reaches the model, and a fetch gives up after 30 seconds.
- Without a model, or when the model fails, the tool returns the page's
  Markdown itself.
- The page counts as untrusted data: the small model is told to ignore
  instructions in it.

## openproject

Registers `openproject`, a tool that calls the
[API v3](https://www.openproject.org/docs/api/) of one or more OpenProject
instances as you: work packages, comments, relations, time entries, versions,
projects, meetings with their agenda items and sections, attachments up and
down, and whatever else the API offers, read and written with your
permissions. Paths below `/api/bcf/2.1` reach the instance's BCF API (BIM
topics and viewpoints). `/spec.json` returns the instance's own description
of the API v3.

- The instances come from `~/.pi/agent/openproject.json`, read the same way as
  [gitlab](#gitlab)'s `gitlab.json` (both files carry the same code): under
  `instances`, a map from each instance's URL to its settings, like
  `mcpServers` in Pi's `mcp.json`; the first is the default. Without the file
  the tool is not registered.

  ```json
  {
    "instances": {
      "https://openproject.example.com": { "token": "$OPENPROJECT_API_TOKEN" },
      "https://community.openproject.org": { "token": "!op read op://Private/OpenProject/token" }
    }
  }
  ```

- `token` reads like `apiKey` in Pi's `models.json`: the token itself,
  `"$NAME"` or `"${NAME}"` for an environment variable, or `"!command"` for
  the output of a shell command. `"tokenEnv": "NAME"` is short for
  `"token": "$NAME"`; without either, the token is `$OPENPROJECT_API_TOKEN`.
  It is a personal API token (in OpenProject: My account → Access tokens → API
  token). An environment variable is read at every call, and Pi must start
  with it set; a command runs at the first call of a session and runs again
  after a 401; a token written into the file draws a warning while others can
  read it. [gitlab](#gitlab) has the details.
- With several instances the tool takes `host`, the host of the instance;
  without it, a call goes to the first. A full URL in `path` picks its
  instance by itself. The hrefs in responses are paths, so following one on
  another instance needs `host` again.
- Each token goes only to its instance. Paths and links outside the instance's
  `/api/v3` and `/api/bcf/2.1` are refused, a redirect to another host
  (attachment storage, another instance) is followed without the token, and
  the token never appears in a result. API v3 gets it as a Bearer token; the BCF API accepts an
  API token only as Basic `apikey:<token>` (Bearer there means OAuth), so its
  requests send it that way.
- No MCP: OpenProject's own MCP server (`/mcp`, since 17.2) is an Enterprise
  add-on from the Professional plan up and answers "MCP server is not
  available" without it. The API needs no add-on.
- Responses are folded before they reach the model. A single work package
  shrinks to about a seventh of its size, a list of them to about a tenth:
  - A link becomes `"Title <href>"`. Templated and representation links,
    empty fields, and embedded copies of linked resources are left out.
  - Formatted texts keep their raw Markdown.
  - The actions you may take on the requested resource are listed under
    `_actions` as `"METHOD href"`.
  - A work package in a list keeps only `self` and its data links (status,
    assignee, project, …); its sub-resources are reachable from its id.
  - `raw: true` returns the response unchanged.
- Output over 50 KB is cut and the full response saved to a temp file. Binary
  content, such as an attachment download, is saved to a temp file (mode 600)
  up to 100 MB. The temp files of a session are removed when it ends. `saveTo`
  keeps a GET's response instead: in a directory under the file's own name, or
  as a new file; an existing file is never overwritten.
- A request body is one of three:
  - `body`, JSON, for POST, PATCH, and PUT (PUT only the BCF API uses);
    `contentType` overrides its type, e.g. `application/hal+json` for
    `emoji_reactions`.
  - `text`, plain text, e.g. the Markdown that `POST /render/markdown` turns
    into HTML.
  - `files`, local files as multipart/form-data, form field name → path. The
    fields of `body` go first, an object as a JSON part, so `metadata` precedes
    the file as OpenProject requires; without it, `metadata` is
    `{"fileName": <the file's name>}`. Upload to a container's
    `/attachments` (work package, meeting, wiki page, post, activity) or to
    `/attachments` alone, which OpenProject keeps for you to claim later. Up to
    100 MB; the instance's own attachment size limit applies.

  Without any of them, a POST, PATCH, or PUT sends `{}` as JSON: OpenProject
  answers 406 "Missing content-type header" to every request but GET and
  DELETE that has no content type, even one without a body (such as
  `POST /notifications/read_ian`).
- Editing a comment (`PATCH /activities/{id}`) takes the comment as a plain
  string, `{"comment": "…"}`. OpenProject 17.8 answers 400 to the
  `{"comment": {"raw": "…"}}` its specification documents there; creating one
  (`POST /work_packages/{id}/activities`) takes that object. The tool's
  description tells the model.
- The response headers must arrive within 30 seconds; an upload and the body of
  a download get 5 minutes.
- A certificate Node cannot verify is reported as [gitlab](#gitlab) does it,
  with `NODE_EXTRA_CA_CERTS` as the remedy for a CA Node does not know.
- Writes need no confirmation. The tool's guidelines tell the model to write
  only what you asked for, to upload only files you named for that, to send a
  PATCH with the `lockVersion` of a fresh GET, and to validate an unclear
  payload against the form endpoint first.
- Out of reach, because no API offers them: PDF, CSV, and XLS exports and a
  meeting's iCal file.
- Of a wiki page, stock OpenProject gives the title and the attachments only.
  An instance whose API extends the wiki is used like any other path, and the
  tool's description tells the model how: `GET /wiki_pages/{id}` with the
  page's text and `lockVersion`, `GET /projects/{id}/wiki_pages` for a
  project's pages, `POST /projects/{id}/wiki_pages` to create a page,
  `PATCH /wiki_pages/{id}` to change its title, text, or parent, and
  `DELETE /wiki_pages/{id}` to delete it. A deleted page is gone with its
  versions and attachments, so the description tells the model to delete only
  a page you named and to ask first when subpages are involved and you did not
  say what happens to them.

## gitlab

Registers `gitlab`, a tool that calls the
[REST API v4](https://docs.gitlab.com/api/rest/) and the
[GraphQL API](https://docs.gitlab.com/api/graphql/) of one or more GitLab
instances as you: issues, merge requests, notes, pipelines, job logs,
repository files, projects, groups, and whatever else the API offers, read and
written with your permissions.

- The instances come from `~/.pi/agent/gitlab.json`: under `instances`, a map
  from each instance's URL to its settings, like `mcpServers` in Pi's
  `mcp.json`; the first is the default. Without the file the tool is not
  registered.

  ```json
  {
    "instances": {
      "https://gitlab.example.com": { "token": "$GITLAB_TOKEN" },
      "https://gitlab.com": { "token": "!op read op://Private/GitLab/token" }
    }
  }
  ```

- `token` reads like `apiKey` in Pi's `models.json`: the token itself,
  `"$NAME"` or `"${NAME}"` for an environment variable, or `"!command"` for
  the output of a shell command, such as a password manager's CLI. `$$` and
  `$!` are a literal `$` and `!`. `"tokenEnv": "NAME"` is short for
  `"token": "$NAME"`; without either, the token is `$GITLAB_TOKEN`.
  - It is a personal access token (in GitLab: User settings → Personal access
    tokens; scope `api`, or `read_api` to read only).
  - An environment variable is read at every call. Pi must start with it set:
    export it in your shell profile or in `~/.pam_environment`, which applies
    only after the next login.
  - A command runs in Pi's shell (`/bin/sh`, Git Bash on Windows) at the
    first call of a session, for up to 30 seconds, time enough to unlock the
    password manager. Its token is kept for the session until the instance
    answers 401; then it runs again.
  - A token written into `gitlab.json` itself draws a warning at session start
    while others can read the file: `chmod 600 ~/.pi/agent/gitlab.json`.
- With several instances the tool takes `host`, the host of the instance
  (`gitlab.com`, or `example.com/gitlab` for GitLab below a path); without it,
  a call goes to the first. A full URL in `path` picks its instance by itself.
  On every instance but the first, the href of the next page is a full URL, so
  that it leads back there.
- Each token goes only to its instance: in the `PRIVATE-TOKEN` header, and to
  `/api/graphql` as `Authorization: Bearer`, as GitLab documents it for
  GraphQL (git.drupalcode.org ignores `PRIVATE-TOKEN` there and answers as an
  anonymous user). Paths and links outside the instance's `/api/v4` and
  `/api/graphql` are refused, and a redirect to another host (object storage,
  another instance) is followed without the token.
- Secrets never reach the model, not even with `raw: true`: the token itself,
  fields named `token` or `*_token` (`runners_token`, a newly created access
  token), and the value of a CI/CD variable that is masked or hidden or whose
  key names a secret (`PASSWORD`, `SECRET`, `TOKEN`, `…_KEY`, …) read
  `[redacted]`, and so does every value sent with `fieldFiles`.
- REST JSON is folded before it reaches the model. A list of issues shrinks
  to about a third of its size:
  - Empty fields, avatar URLs, and the `_links` of list items are left out,
    and so is an object of zeros only (`time_stats`).
  - A user inside another resource or a list (author, assignees, merged_by)
    reads `"Name (@username, id N)"`, with its state when it is not active.
  - A description in a list is cut after 400 characters; the single issue or
    merge request has all of it.
  - The pagination headers become a line above the body: page, total, and the
    href of the next page, which the tool takes as its path.
  - `raw: true` returns the response unfolded.
- `files` uploads local files as `multipart/form-data` with POST or PUT,
  form field name → path: a project avatar is `PUT /projects/{id}` with
  `files: {"avatar": "~/logo.png"}`, an image for Markdown
  `POST /projects/{id}/uploads` with `files: {"file": "./diagram.png"}`. The
  fields of `body` go along as form fields (arrays as `key[]`). Like the token,
  files go only to the instance of the call, up to 100 MB in all; GET, DELETE,
  and GraphQL take none.
- `fieldFiles` takes body fields from local files with POST or PUT, field name
  → path, so a secret stays out of the call, the result, and the transcript:
  a CI/CD variable is `POST /projects/{id}/variables` with
  `body: {"key": "E2E_HTTP_PASSWORD", "masked": true, "environment_scope": "*"}`
  and `fieldFiles: {"value": "/tmp/secret"}` (a file of mode 600, written
  e.g. from a vault). The text of the file,
  UTF-8 and up to 64 KB, with one trailing newline cut off, becomes the string
  value of the field and wins over the same field in `body`; a directory, a
  larger or a non-UTF-8 file is refused without showing its content. The value
  is masked in everything the tool returns, whatever the field and the status,
  and the call shows only its path. With `files`, it goes along as a form field.
  GET and DELETE take none.
- File contents (`…/raw`) and GraphQL answers come as they are. A job log
  (`…/jobs/{id}/trace`) comes without its colour codes, and when it is cut,
  it keeps its end, where the failure is.
- Output over 50 KB is cut and the full response saved to a temp file. Binary
  content, such as artifacts and archives, is saved to a temp file (mode 600)
  up to 100 MB. The temp files of a session are removed when it ends.
- `path` also takes a web URL of an instance, read as its API path: a project,
  a merge request, an issue or work item, a pipeline, a job, a commit, a file
  (`/-/blob/<ref>/<file>`, `/-/raw/…`), or a tree. What follows the number
  (`/diffs`), the query, and the fragment are dropped; the URL picks its
  instance. A ref with a slash in it (`feature/x`) is cut at the slash, and
  other pages of the instance are refused with the forms known.
- `overview: true` with a GET of one merge request returns in one result the
  merge request, its approvals, its latest pipelines, its open discussions
  (unresolved threads and comments, without system notes, bodies cut after
  500 characters, with `file:line` of a diff note) and its changed files as
  paths, without the diffs. The parts are fetched in parallel; a part that
  fails shows its error in its section.
- GraphQL is there for what REST lacks: an issue's iteration, for one, can
  only be set through `issueSetIteration`. A GraphQL answer with `errors`
  counts as failed. The tool description names `/api/graphql` as the
  endpoint of the GraphQL API; `/graphql` and `/api/v<n>/graphql` of any
  version lead there as well, as a path or a full URL: GitLab has no REST
  route of that name, and models guess them.
- Requests go through `node:https`, not `fetch`: `fetch` sends
  `Sec-Fetch-Mode: cors`, and GitLab answers that with 406 on downloads such
  as repository archives. They use the proxy Pi uses for its own requests:
  Pi's `httpProxy` setting, applied as `HTTPS_PROXY` and `HTTP_PROXY`, or
  those variables themselves, with `NO_PROXY`. HTTPS goes through a `CONNECT`
  tunnel, and a user in the proxy URL is sent as `Proxy-Authorization`.
- A certificate Node cannot verify ends the call with
  `… is unreachable: its certificate cannot be verified (…)`. When its chain
  ends in a CA Node does not know, such as a company proxy's that inspects
  TLS, the message names the remedy: `NODE_EXTRA_CA_CERTS` pointing to a PEM
  file with that CA, and a restart of Pi, as Node reads it only at start. A
  run-out certificate or one for another host is reported as not valid.
- Writes need no confirmation. The tool's guidelines tell the model to write
  only what you asked for and to read a single issue or merge request before
  changing its description.
- Git itself — clone, fetch, push — stays with `git`.

### gitlab_pipeline

A second tool for CI pipelines and jobs, with the same instances, tokens, and
rules. The `gitlab` tool can do all of it, but each step costs a request:
find the job among lists of 3 KB per job, poll with `wait` and a regular
expression over folded JSON, read 13 KB of log for the last 20 lines, post
the play and follow the new job id. `gitlab_pipeline` does each in one call
and answers in a few lines. `"pipelines": false` in `gitlab.json` leaves it
out.

- `action` is one of:
  - `status`: the pipeline (id, ref, commit, status, duration, who started
    it) and a table of its jobs — stage, job, status, time, runner, id — in
    stage order. A trigger job shows its downstream pipeline, a failed job
    allowed to fail says so, and the manual jobs waiting to be played are
    listed below.
  - `wait`: checks a job, or the pipeline, every `interval` seconds (15)
    until it settles — success, failed, canceled, skipped, or held at a
    manual job — for at most `timeout` minutes (30, at most 180). The checks
    cost no model requests, and the tool row shows the state meanwhile. A
    failed pipeline or job comes with the last 15 lines of the logs of its
    failed jobs (at most three).
  - `log`: the end of a job log (`lines`, 60, at most 500), or with `grep`
    the lines matching a regular expression, case-insensitive, with their line
    numbers. Colour codes, timestamps, section markers, and the progress a
    carriage return overwrote are gone.
  - `play` starts a manual job, with `variables` as its job variables;
    `retry` runs a job again, or without `job` the failed and canceled jobs
    of the pipeline; `cancel` stops a job or the pipeline that is still
    running; `run` starts a pipeline for `ref` (default the default branch)
    with `variables`. With `wait: true` they wait for the job or pipeline
    afterwards.
  - `chain` runs a rollout in one call: the jobs of `jobs` one after the
    other, then the URLs of `check`. A manual job is played (with
    `variables`), one not ready yet — an earlier stage still running — is
    awaited until it can be played, and one that succeeded already is left
    alone; a job that fails stops the chain, with the end of its log, and the
    jobs after it are not played. All names must exist in the pipeline, or
    nothing is played and the manual jobs it has are listed. Once all jobs
    succeeded, each URL is fetched without a token, up to five redirects: a
    5xx or no answer is tried again for about a minute and fails the chain,
    401 and 403 count as reachable (a login in front). The answer is one line
    per job and per URL and one for the outcome; `timeout` covers the whole
    chain, and `stop_wait` or the panel stop it before the next play.
  - `stop_wait` ends the background wait `waitId`; the pipeline or job
    itself goes on.
  - `list` lists the background waits, those of [wait](#wait) too.
- `needResult` is required with `wait`, `chain`, and with `wait: true`, as with
  [wait](#wait): the model says each time whether its next step needs the
  result. `false` returns at once with an id (`gp1`) and waits on its own,
  for at most `timeout` minutes (120 there). Your messages do not stop it.
  When the job or pipeline settles or the time is up, a message brings the
  result into the conversation: while Pi works, with its next step, so the
  result is not stale by the time it comes; when Pi is idle, it starts a
  turn. `/gitlab-waits` lists the background waits with their last state,
  `/gitlab-waits stop <id>` ends one. The message takes one line, the wait's
  id and what it waited for on the left, how it ended and the time on the
  right (`✓ success · 3m 12s`); a click or Ctrl+O shows its whole text.
- `needResult: true` waits in the foreground. A message from you, or five
  minutes without a result, sends the wait to the background, where it goes
  on with the checks it made. Without a terminal, in a subagent or in print
  mode, every wait is in the foreground.
- Background waits go on over `/reload`, and a result that comes while Pi
  reloads arrives once it has. Another session (`/new`, `/resume`, `/fork`)
  ends them, as they belong to the conversation that started them, and names
  them in a notice. The [agent panel](#background-agents) lists them, and
  [tmux-tab-activity](#tmux-tab-activity) turns its slow spinner for them.
- A check that fails on the network, with a server error, or with 429 is
  repeated, up to three in a row; a refusal (401, 403, 404) ends the wait at
  once.
- The project is `project` — `group/project`, its id, or a web URL of the
  project or of one of its pipelines, jobs, or merge requests — or else the
  project of the working directory's `origin` remote, on the instance that
  remote belongs to.
- The pipeline is `pipeline` (its id, as in `/-/pipelines/<id>`), else the
  head pipeline of merge request `mr`, else the pipeline of a job given by id,
  else the latest of `ref`, else the latest of the project. A job is its name
  in that pipeline (the latest run of it) or its id.
- Every call answers with one or two lines on what it did and the state
  after it. Errors say what to do instead: a job that is not manual cannot be
  played, a finished pipeline cannot be canceled, a name the pipeline lacks
  lists the names it has.
- The guidelines tell the model to play, retry, cancel, and run only what you
  asked for, and a deploy job only on your word for that deploy; `chain`
  plays exactly the jobs given and never picks an environment itself.

### gitlab_work

A third tool for what takes several `gitlab` calls each time: issues from a
template, merge requests from creation to merge, and what is deployed where.
`"work": false` in `gitlab.json` leaves it out. The project is given as for
[gitlab_pipeline](#gitlab_pipeline) — path, id, web URL (an issue's or merge
request's URL gives its iid too), or the `origin` remote.

- `action` is one of:
  - `issue_template`: the project's issue templates, or with `template` the
    content of one, in one call.
  - `issue_create`: `title` with `description` (or `descriptionFile` for a
    long text), assigned to you unless `assignee` names others, with
    `labels`, `due_date`, `milestone_id`, `confidential`. `iteration`
    defaults to `current`: the current iteration of the project's group
    hierarchy, set through `issueSetIteration` after the create, since the
    REST create ignores it. With several current iterations (several
    cadences) none is set and the candidates are listed; `none` skips it.
    With `template`, a description that drops or reorders the template's
    headings is refused before anything is created.
  - `issue_update`: iteration, labels (all, or `add_labels` and
    `remove_labels`), `state_event` close or reopen, assignee, title, and
    description in one call.
  - `issue_view`: the issue, its notes without system notes (cut after 500
    characters, newest last), its related merge requests, its linked issues,
    and its iteration, fetched in parallel; a part that fails shows its error
    in its section.
  - `mr_create`: `source_branch` into `target_branch` (default the default
    branch), assigned to you, removing the source branch after the merge,
    with the project's squash setting; `reviewer`, `labels`, and `draft` as
    wanted. An open merge request of that branch is returned instead of an
    error, and a branch just pushed that GitLab does not see yet is tried
    again once.
  - `mr_merge`: waits while GitLab is still checking (no model requests,
    `timeout` 10 minutes, at most 30), then merges with the head it checked
    (`sha` guards against new commits). A block — conflicts, open threads, a
    missing approval, a draft — is reported at once. A pipeline still
    running is reported too, unless `when_pipeline_succeeds` sets auto-merge
    or `wait_for_pipeline` waits for it.
  - `deployed`: per environment the last successful deployment — ref,
    commit, time, job, user — from the environments API; a project without
    environments falls back to its latest successful jobs matching `jobs`
    (a regular expression, default `deploy`). `contains` (a commit, tag, or
    branch) adds whether each deployed commit contains it.
- The guidelines tell the model to prefer `gitlab_work` for these tasks, to
  create and change only what you asked for, and to merge only on your
  approval of that merge or a standing one.

## onepassword

Adds tools for 1Password through its CLI `op`, signed in through the
1Password app (Settings → Developer → Integrate with 1Password CLI). Without
`op` on the PATH it adds nothing. The tools reach every vault your account
can see.

- You approve Pi once per session, not once per command. The app ties an
  approval to a terminal session, on Linux to the terminal and a start time,
  for 10 minutes of inactivity, which every use renews, and at most 12 hours.
  Pi's `bash` tool starts each command without a terminal, so `op` there asks
  every time; these tools start `op` from Pi's own process, in Pi's terminal.
  On macOS, `op` 2.40 and later shares one approval among a program's calls
  anyway.
- No secret value reaches the model:
  - `onepassword_items` lists items by id, title, category, and vault,
    optionally of one vault, category, or tag, or with part of the title.
  - `onepassword_item` shows an item's fields by section, label, and type,
    whether each is set, and its `op://` reference; of the websites only the
    host, of the notes only whether there are any, since a URL or a note can
    hold a password.
  - `onepassword_run` runs a shell command with secrets in environment
    variables given as `op://` references (`op run`): `op` resolves them for
    that command alone and masks their values in its output. The command
    runs without a terminal, as the `bash` tool's do.
  - `onepassword_write` creates or changes an item: text fields from values
    in the call, secret fields (concealed, one-time password) only from a
    generated password, a command's output, or a file. The item goes to `op`
    in a private temporary file, removed at once, never as command
    arguments, which other processes can read. 1Password keeps earlier values
    in the item's history.

For example, a registry login without the token in the conversation:

```json
{
  "command": "printenv TOKEN | docker login -u ci --password-stdin registry.example.com",
  "env": { "TOKEN": "op://Shared/Registry/token" }
}
```

## vault

Adds tools for the KV version 2 secrets engines of HashiCorp Vault, through
Vault's HTTP API. The address comes from `VAULT_ADDR`, without which it adds
nothing; the token from `VAULT_TOKEN` or `~/.vault-token`, where `vault
login` keeps it, read anew for every call; `VAULT_NAMESPACE` where set. What
a tool may do is up to the token's policies.

- Paths are written as for the `vault` CLI, with the mount first, such as
  `secret/app/database`; a field is `path#field`.
- No secret value reaches the model:
  - `vault_list` lists the folders and secrets under a path, or the KV
    version 2 mounts.
  - `vault_secret` shows a secret's versions and its fields by name, whether
    each is set, and its `path#field` reference; of the custom metadata only
    the keys.
  - `vault_run` runs a shell command with secrets in environment variables
    given as `path#field` references. The values go to that command alone
    and are masked in its output. The command runs without a terminal, as
    the `bash` tool's do.
  - `vault_write` sets or removes fields of a secret and keeps the others. It
    reads the secret and writes it back with check-and-set, so a change made
    meanwhile is not overwritten. A secret value comes only from a generated
    password, a command's output, a file, or another secret's field; a value
    in the call is for what is not secret, such as a user name. A new secret
    needs `create`, so a typing error makes no new path. Its action `delete`
    deletes the secret's current version: Vault keeps the earlier versions,
    and whoever may can undelete it.
- `vault_login` logs in with OIDC through the `vault` CLI, when the token is
  missing or expired: your browser opens the identity provider's page, and
  the new token goes to `~/.vault-token`. Without the CLI on the PATH it is
  left out. The identity provider's client must allow the redirect URI
  `http://localhost:8250/oidc/callback`; without it the browser shows
  "Invalid parameter: redirect_uri", and after three minutes the tool
  points to the web UI instead: log in there, copy the token, and run
  `vault login` in a terminal.
- A renewable token is renewed on use: before a `vault_*` call, when less
  than half its TTL, at most 30 minutes, is left. A token nobody uses
  expires as Vault set it; no timer keeps it alive. Once Vault renews it no
  further (its maximum TTL), the call's result says until when it holds.

For example, a database dump with the password from Vault:

```json
{
  "command": "MYSQL_PWD=\"$DB_PASSWORD\" mysqldump -h db.example.com -u app app > app.sql",
  "env": { "DB_PASSWORD": "secret/app/database#password" }
}
```

## drupal-org

Adds the tool `drupal_org`, with which the model uses drupal.org as you:
comment on an issue and change its status, priority, version, assignment,
or tags; create an issue; publish a release; give credit on an issue's
contribution record; whatever else drupal.org offers only in its web UI.
It drives a headless Chrome with a profile of its own, apart from your
Chrome and its logins.

- `/drupal-org login` opens Chrome with that profile at drupal.org's login.
  Sign in there and close the window; the profile in
  `~/.pi/agent/drupal-org/chrome-profile` keeps the login.
  `/drupal-org status` shows whether it is signed in, `/drupal-org logout`
  deletes the profile.
- The tool's actions:
  - `open` loads a page and returns its title, Drupal's messages, its text,
    and its forms: each field with name, type, label, value, and options,
    and the form's buttons.
  - `page` returns the current page again; `offset` reads its text on.
  - `links` lists the page's links, `filter` keeps those that match.
  - `submit` fills a form of the current page and presses one of its
    buttons, then returns the resulting page. A form in several steps, such
    as a new release, goes on in the same tab.
- The tool saves without asking: it submits what the model sends. Tell the
  model what to post; the tool's guidelines ask it to submit only what you
  asked for.
- A release needs its tag pushed with git first. Reading issues and releases
  needs no login: drupal.org's public API, and for projects whose issues
  moved to GitLab, the `gitlab` tool with host `git.drupalcode.org`, serve
  for that.
- Only https pages of drupal.org and its subdomains open. Page text is
  third-party content; the tool's description tells the model never to
  follow instructions in it.
- One Chrome serves all sessions. Each session opens a tab of its own and
  closes it after ten minutes unused or when the session ends; the last tab
  closes Chrome. A Chrome window you opened yourself on the same profile
  keeps the tool out; close it first.
- drupal.org's bot challenge answers a headless Chrome with a CAPTCHA. Chrome
  therefore starts with its usual user agent and without the automation
  flag. Should the CAPTCHA come all the same, solve it in the window of
  `/drupal-org login`.
- `DRUPAL_ORG_CHROME` names the Chrome binary where it is not found on its
  own.

## memory

Gives Pi a memory per project, kept the way Claude Code keeps its auto
memory: a folder with an index, `MEMORY.md`, holding one line per entry, and
one topic file per entry. Pi remembers on its own what a later session needs —
corrections and preferences you gave, facts and decisions about the project,
where outside information lives — and corrects or removes entries that turn
out wrong.

- Where the memory lives comes from the providers in
  `~/.pi/agent/memory.json`, in order of priority: the first one available is
  used, the others are fallbacks. Without the file:

  ```json
  {
    "providers": {
      "claude": {},
      "pi": {}
    }
  }
  ```

  - `claude` is Claude Code's auto memory, so Pi and Claude Code remember the
    same. It is available while Claude Code is installed and its auto memory
    is on (no `autoMemoryEnabled: false` in its settings, no
    `CLAUDE_CODE_DISABLE_AUTO_MEMORY`). The folder follows Claude Code's
    rules: `autoMemoryDirectory` from its settings, else
    `~/.claude/projects/<project>/memory/` (`CLAUDE_CONFIG_DIR` and
    `CLAUDE_CODE_PROJECT_DIR_NAME` honoured).
  - `pi` is `~/.pi/agent/memory/<project>/`, always available.
  - Every provider takes a `"dir"` with `{project}` for the project key — a
    synced folder, for one — and a provider of another name needs one.
- The project is the git repository, its main worktree, so that subfolders
  and worktrees share one memory, as in Claude Code; outside a repository,
  the working directory. Claude Code's project settings count only once Pi
  trusts the project. A project without a memory gets the folder and the
  index with its first entry.
- The index goes into the system prompt on every run, read fresh, cut at 200
  lines, together with the rules for writing: what to save and what not
  (nothing the repository already says, no secrets), the file format Claude
  Code uses (frontmatter with `name`, `description`, and `metadata` with
  `type` and `modified`; **Why:** and **How to apply:** for feedback and
  project entries), one index line per file, and updating instead of
  duplicating. The topic files are read on demand.
- In a session the index in the system prompt stays as the model first saw
  it, or as it was after the last compaction. When it changes, Pi would send
  the whole section again, and every later request would carry each copy;
  instead the next run gets a hidden message with the lines added, changed,
  and removed. A change to more than half of the lines shows the whole index
  again.
- `/memory` shows the providers with the one in use and the index;
  `/memory edit` opens the index in Pi's editor.
- `/memory lint` checks the memory against its rules and what it costs: index
  lines over 150 characters, an index over 200 lines (the prompt gets the
  first 200), links to missing files, topic files without an index line or
  without frontmatter, and topic files over 8 KB. The index is in every
  request, and a topic file costs its size each time it is read, so both pay
  for being short. A subject too large for one file gets a core file with a
  topic map that links its other files (`[[name]]`): only the core file needs
  an index line, and the files its map links count as indexed, also through
  further topic maps (index → hub → core file → file).
- The same limits hold when the model writes. A write or edit is refused
  when it would put an index line over 150 characters or the index over 200
  lines, write a topic file without frontmatter, or let a topic file over
  8 KB grow; the reason says what to do instead (shorten the line and keep
  the details in the topic file; split the file by subject). Edits that
  shrink a large file pass, so it can be tidied. `{"guard": false}` in
  `memory.json` turns the check off. Claude Code, which writes to the same
  memory, is not checked.
- `/memory tidy` hands what `/memory lint` lists to the model as a task:
  shorten the lines, split the large files, fix links and frontmatter. It
  shows what it would remove before it removes anything.
- `/memory migrate [provider]` copies this project's memory from another
  provider's folder into the one in use, as long as that has no entries yet:
  after a switch (Claude Code removed, its auto memory turned off, or
  `memory.json` reordered) the entries come along. It takes the named
  provider, else the first in order of priority with an index; Claude Code's
  and Pi's own folders count even where `memory.json` leaves them out. The
  source stays as it is, and no file in the target is overwritten except an
  index without entries.
- At start, a notice names the memory in use, and a second one counts what
  `/memory lint` would list. Subagents get no memory, as in Claude Code.

## session-title

Names a session after its first prompt, the way Claude Code titles its
sessions: three to six words in the language of the prompt, written by the
[small model](#small-model). It takes one to three seconds and runs in the
background while the agent works.

- Pi shows the name in the terminal title, `π - <name> - <directory>`, and in
  `/resume` instead of the first message.
- A name set with `/name` or `pi --name` is never replaced; `/name <title>`
  changes a generated one.
- A resumed session without a name is titled after its first prompt, not after
  the one that resumed it.
- A session gets one attempt each time it is opened. When it fails, a warning
  names the reason.
- Only the interactive terminal and RPC clients get titles; `pi -p` and JSON
  mode skip them.
- The prompt, cut at 4,000 characters, goes only to the provider of the
  current model.

## tmux-tab-activity

While Pi or one of its subagents works, Pi's spinner turns in its tmux tab in
place of the `π` between the window number and the session name, so the tab
bar shows which sessions are busy. The spinners of all tabs turn in step.

- Pi shows the session in the terminal title, `π - <name> - <directory>`. During
  a run, a compaction, while a subagent works (one that waits for your
  instruction, an answer, or a usage limit does not count), the extension
  writes it as `π - ␟⠹ <name> - <directory>` (an unnamed session's directory
  as its name): `␟` marks the title of a working session, and the spinner's
  frame follows it, which the tab formats below put in place of the `π`. The
  frames are Pi's own, `⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏`, one every 80 ms, each taken from the
  clock, so all tabs show the same frame.
- It pauses while an `ask_user_question` dialog waits, when the dialog's mark
  takes over, while a run waits for a usage limit to reset
  ([auto-continue](#auto-continue)), and while a run only waits in its own
  `agent` calls whose subagents all wait (for your instruction, an answer, or
  a usage limit). It puts Pi's own title back when Pi settles and no subagent
  works.
- Background waits of [wait](#wait) and [`gitlab_pipeline`](#gitlab_pipeline),
  a `chain` among them, check without the model while the session is idle:
  while one runs and nothing works, the spinner turns slowly instead, a frame
  every 300 ms, in step with the other tabs that wait. A repeating wait (a
  keepalive) does not count, and an open question stops it as well.
- A window with several panes shows the pane whose Pi works: the active
  pane's while it works, else the first other pane's that works, else the
  active pane's. While another pane works, the tab shows that pane's name, so
  its width changes when that run starts and ends.
- A window renamed by hand keeps its name, with `π` or the spinner before it.
  A window without Pi shows its number and command.
- tmux takes a title as the pane title at once, but names the window after it
  at most every 500 ms, so the tab has to show the pane title itself. Set up
  tmux 3.2 or later like this, in `~/.tmux.conf` or
  `~/.config/tmux/tmux.conf`, then `tmux source-file` it and `/reload`
  running sessions:

  ```conf
  # The window name: the session name from Pi's title without the spinner,
  # else the command.
  set -g automatic-rename on
  set -g automatic-rename-format '#{?#{m:π - *,#{pane_title}},#{s/^␟. //:#{s/^π - (.*) - .*$/\1/:pane_title}},#{pane_current_command}}'
  # The tab: its number, then π for a window with Pi, which the spinner takes
  # the place of while a pane's Pi works, then the session name from a pane's
  # title; the active pane's while it works, else the first other pane's that
  # works (␞ separates their names, the first stays), else the active pane's.
  # A window renamed by hand keeps its name (#W).
  %hidden PI_NAME='#{s/^π - (.*) - .*$/\1/:pane_title}'
  %hidden PI_BUSY='#{m:π - ␟*,#{pane_title}}'
  %hidden PI_OTHERS='#{s/␞.*$//:#{P:#{?#{m:π - ␟*,#{pane_title}},#{s/^π - (.*) - .*$/\1/:pane_title}␞,}}}'
  %hidden PI_LIVE="#{?$PI_BUSY,$PI_NAME,$PI_OTHERS}"
  # The spinner, undimmed (#[nodim fg=blue] gives it a colour); π and the
  # frames are one column each, so the tab keeps its width.
  %hidden PI_SPIN="#{s/^␟(.).*$/#[nodim]\\1#[default]/:$PI_LIVE}"
  %hidden PI_MARK="#{?$PI_LIVE,$PI_SPIN ,#{?#{m:π - *,#{pane_title}},π ,}}"
  %hidden PI_TAB="#I $PI_MARK#{?$PI_LIVE,#{?#{automatic-rename},#{s/^␟. //:$PI_LIVE},#W},#{?#{&&:#{automatic-rename},#{m:π - *,#{pane_title}}},$PI_NAME,#W}}"
  set -g window-status-format " $PI_TAB"
  set -g window-status-current-format " $PI_TAB"
  ```

- While an `ask_user_question` dialog is open, its own questions or a
  subagent's, the pane has the option `@pi_ask`, so the tab formats can mark
  the window, the active one too, which tmux's bell flag never does. Nothing
  rings. The next Pi in a pane removes a mark a crashed Pi left:

  ```conf
  %hidden PI_ASK="#{P:#{?@pi_ask,1,}}"
  set -g window-status-style "#{?$PI_ASK,nodim#,bold#,blink,dim}"
  set -g window-status-current-style "reverse#{?$PI_ASK,#,blink,}"
  ```

- It checks the setup when a run starts, and turns the spinner only while a
  tab format shows the pane title (`pane_title` or `#T`) and takes the
  spinner from behind `␟`, and `set-titles` does not hand the pane title on
  to the outer terminal, whose title would change with every frame. Outside
  tmux, in subagents, and in print and RPC mode it does nothing.
- Pi only writes its title, twelve and a half times a second while it works,
  and tmux redraws its status line for each frame; no tmux command runs per
  frame. Ways through tmux commands were set aside: one process per frame
  costs more, and a control-mode client counts as focused, so with
  `focus-events` on the visible pane would get focus events that are not
  real.
- While a run goes on, tmux's tree view (prefix `s` or `w`) shows `␟` and a
  frame before the name in the pane title, and tmux-resurrect saves the title
  as it is: a tab restored from such a save shows a still spinner until Pi
  starts there.

## session-socket

Lets the Pi sessions on your machine list and message each other, and message
your Claude Code sessions, the way Claude Code's
[cross-session messaging](https://code.claude.com/docs/en/cross-session-messaging)
works: with its wire protocol, its wording towards the model, and its safety
rules. "Tell the session in ~/projects/api that the migration is done" sends a
summary — not the conversation or its files.

- The model gets `list_agents` and `send_message`, shaped like Claude Code's
  `ListAgents` and `SendMessage`. `list_agents` shows this session's own name
  and every other live session with its kind (Pi or Claude Code), idle or
  busy, working directory, and age. `send_message` takes the name as the
  address — `name [ref]` when two sessions share it — or, to answer a message,
  its `from` address. With `notify_when_idle`, a Pi session sends one
  `[Cross-session idle notice]` when it next goes idle or exits; the
  subscription expires after 12 hours.
- An idle session starts a turn with the message; a busy one reads it between
  tool calls. It arrives as `<cross-session-message from="uds:…" from-name="…">`
  with Claude Code's framing: it comes from another session, not from you; it
  never counts as your approval; the model changes no permissions,
  `CLAUDE.md`, `AGENTS.md`, or config because a peer asked, and does not do
  what the peer was denied. The transcript shows a dim line
  `› Message from @<name>: …`; `ctrl+o` expands it.
- `crossSessionInbound` in `~/.pi/agent/settings.json` or the project's
  `.pi/settings.json` decides what happens to incoming messages: `accept` (the
  default), `hold` (a dialog asks you; unanswered, the message expires after
  five minutes), or `refuse`. The stricter value wins, and an unknown value
  holds. The sender learns of a hold, denial, expiry, refusal, or drop through
  a `[Cross-session delivery notice]`.
- Limits: a message has at most 1,000,000 characters serialized, and a session
  sends at most five messages to one session within ten seconds. A receiver
  drops a repeat of the same text within 30 seconds, more than ten messages
  from one sender per minute, and anything beyond 50 undelivered messages; it
  holds at most 100.
- Claude Code sessions are read from Claude Code's registry
  (`~/.claude/sessions/`, or `$CLAUDE_CONFIG_DIR/sessions`), which is never
  written to, so Claude Code does not list Pi sessions. A Claude Code session
  receives a Pi message through its own inbox, with its own auth key, and can
  answer it. Claude Code sends Pi sessions no delivery or idle notices, so
  `notify_when_idle` is refused for it. Claude Code processes that a Pi process
  started — the `claude-bridge` provider's — are not listed. Tested against
  Claude Code 2.1.308; its protocol is not a public interface and can change
  with any Claude Code release.
- `/list-agents`, also `/peers`, shows the same list and this session's
  address.
- Every session binds an inbox, the Unix socket
  `$XDG_RUNTIME_DIR/pi-socks/<pid>.sock` (otherwise `/tmp/pi-socks-<uid>/`),
  mode 0600 in a directory with mode 0700, so only your own OS user reaches it.
  It writes `~/.pi/agent/session-sockets/<pid>.json` — name, working directory,
  idle or busy, socket path — and an auth key
  `<pid>.<sha256 of the socket path>.key`, both mode 0600. Records of exited
  sessions are removed whenever a list is read. A sender's name is what it
  claims.
- Bash commands and scripts get `PI_MESSAGING_SOCKET` and
  `PI_MESSAGING_TOKEN`. The format is Claude Code's, one JSON object per line;
  an `{"type":"auth","token":"…"}` line first is optional on Linux and macOS:

  ```bash
  printf '%s\n' '{"type":"user","message":{"role":"user","content":"Build is green"}}' \
    | socat - UNIX-CONNECT:"$PI_MESSAGING_SOCKET"
  ```

- Not ported: messages across machines (Remote Control, cloud), teammates and
  messages to subagents, permission-mode classes, and renaming by a peer.
  Subagent processes bind no inbox, so they never appear in the list. Tested
  on Linux; on native Windows the extension stays out (no tools, no warning).

## ask-user-question

`ask_user_question`, shaped like Claude Code's `AskUserQuestion`, so skills
that ask through it, such as setup wizards, work unchanged.

- One to four questions per call, each with a short header, two to four
  options, and optionally several answers; `Other` takes an answer in your own
  words.
- Several questions get a tab each and a Submit tab. Up/Down or the digits
  pick, Space toggles in a multi-select, Enter confirms, Tab/Left/Right switch
  questions, Esc dismisses.
- The highlighted option has the selection background, as in Claude Code,
  and an arrow (`→`) in front, as in Pi's own lists.
- The dialog rings no bell; [tmux-tab-activity](#tmux-tab-activity) marks
  the tab of a session that waits for an answer.
- In fullscreen mode (`tuiMode`) the mouse works as well: the highlight follows
  the pointer and goes back to the option chosen with the keys when the pointer
  leaves the options; a key acts on the option highlighted, which then becomes
  the one chosen with the keys. A tab under the pointer gets a lighter
  background than the open one, a click on an option picks it as Enter does
  (toggles it in a multi-select), a click on a tab opens it, a click on the
  submit line of the Submit tab submits, and the wheel moves the highlight. In the regular mode
  the terminal keeps the mouse. Under tmux, zellij, or screen Pi asks the
  terminal only for button motion, so there the highlight does not follow a
  pointer that merely moves.
- RPC clients get one select dialog per question. In `pi -p` and JSON mode the
  call fails with a note to decide alone.
- A subagent's questions open in the session that started it, in this same
  dialog, under a line that names the agent (see [subagents](#subagents)).
  The subagent hands them over as one request; a session without this
  extension gets one select dialog per question instead.
- With Remote Control active the questions can also be answered in the Claude
  app (see claude-remote-control). The first answer wins, from either place,
  and closes the other. Interrupting the run withdraws the questions.

## subagents

The `agent` tool, after [Claude Code's subagents](https://code.claude.com/docs/en/sub-agents):
a subagent is a separate Pi process with its own context window, and only its
final report comes back. Beyond Claude Code, you can write to a subagent,
interrupt it, and answer its questions, and it stays alive after its report.

- Agent types: the built-ins `general-purpose`, `Explore`, and `Plan` (the
  last two without `edit` and `write`), and definitions in Claude Code's format
  — Markdown with `name`, `description`, `tools`, `disallowedTools`, `model`,
  `effort`, `maxTurns`, `skills`, `omitClaudeMd`, `background` — from
  `~/.pi/agent/agents/` and the trusted project's `.pi/agents/`.
  [claude-code-agents](#claude-code-agents) adds Claude Code's directories.
- A subagent gets the parent's active tools, narrowed by its definition, whose
  `tools` and `disallowedTools` name Pi tools (`read`, `bash`, …). It never
  gets the cron tools, `list_agents`, or `send_message`, and subagents nest at
  most three levels deep. MCP servers start in it only when its tools name an
  MCP tool.
- A subagent's dialogs open in your session, one at a time, titled with the
  agent: the questions of `ask_user_question`, which it has where the session
  has a user interface, and an extension's confirmation. The questions look as
  the session's own do: tabs, multi-select, previews, and the mouse (see
  [ask-user-question](#ask-user-question)). Without a user interface the
  dialogs are declined. Its notifications, status entries, and widgets stay
  with it.
- Model: the call's `model`, else the definition's, else a default model,
  else the current one. The default model comes from a provider
  ([claude-code-agents](#claude-code-agents):
  `CLAUDE_CODE_SUBAGENT_MODEL`), else from `defaultModel` in
  `~/.pi/agent/subagents.json`, such as `{"defaultModel": "sonnet"}`: a
  subagent without a model of its own then runs on Sonnet instead of the
  session's model, at half of Opus's price per token. A model is a full model
  id, `inherit` (the current one), a tier, or a model family:
  - `small` and `large` stay with the current model's provider. `small` is
    the newest model of a small family the provider has (`haiku`), else the
    model of the [side tasks](#small-model), the cheapest; `large` is the
    newest of a large family (`opus`, then `fable`), else the current model.
    A current model of such a family stays. `~/.pi/agent/subagents.json`
    names the model of a tier per provider where that does not fit:
    `{"tiers": {"<provider>": {"small": "<model-id>", "large": "<model-id>"}}}`.
  - [claude-code-agents](#claude-code-agents) adds the families `sonnet`,
    `opus`, `haiku`, and `fable` and a default model. A family resolves to
    its newest model on the current provider; one the provider lacks falls
    back to its tier (`haiku` to `small`, `opus` and `fable` to `large`,
    `sonnet` to the current model), with a note in the result.
  - The tool offers the tiers and the families the current provider has, and
    renews the offer on a switch to another provider.
  - It also offers a ladder, from the weakest model to the strongest, and the
    model is told to take the weakest rung that does a task reliably. A rung
    is the newest model of each line of the current model's maker on its
    provider (`claude-opus-4-8` and `claude-opus-5-5` are one line), ordered
    by list price, with the current model in place of its line's newest; no
    special-purpose models, at most six rungs besides the current model.
    Each rung says what it is for: mechanical work (search, lists, facts),
    well-specified implementation, judgement (unclear bugs, design, reviews,
    security), and the strongest only when the rung below is not enough. On
    a Claude provider that is `haiku`, `sonnet`, `opus`, `fable`. A provider
    without list prices gets no ladder. The ladder is renewed on a switch to
    another model.
  - The ladder can be defined by hand instead, per provider, under `ladder`
    in `~/.pi/agent/subagents.json`. A provider without an entry keeps the
    automatic ladder. Example:

    ```json
    {
      "ladder": {
        "claude-bridge": [
          { "model": "haiku", "use": "searches, lists, summaries" },
          "claude-sonnet-5-5",
          { "model": "opus", "use": "design, reviews, unclear bugs" }
        ]
      }
    }
    ```

    - The key is the provider as Pi names it (`claude-bridge`, `anthropic`,
      `openai`, …; `pi --list-models` shows it). The ladder applies while
      the current model is one of that provider.
    - The list goes from the weakest model to the strongest, in the order
      written; it is not sorted. The model is told to take the weakest rung
      that does a task reliably, so the order matters.
    - An entry is a string or an object with `model` and an optional `use`.
      `model` is a model id of that provider (a leading `<provider>/` may
      stay), or a part of ids such as `opus`: then the newest model whose id
      holds it, or the current model when its id does, so the ladder follows
      new releases. `use` is the work the rung is for; without it the rung
      gets the default text of its place (lowest: mechanical work; top:
      judgement, or only when the rung below is not enough).
    - Models the provider does not offer are left out, and so are repeats.
      An empty list turns the ladder off for that provider, and so does one
      with fewer than two models left. A broken file is ignored.
    - Prices are shown when every rung has one. The current model is not
      added; `inherit` reaches it anyway.
    - The ladder only changes the text the model reads. `small`, `large`,
      families, and `defaultModel` resolve as before.
    - Pi reads it at session start and on a switch of model: after an edit,
      `/reload`.
- Thinking: a subagent does not take the session's thinking level but the
  one Pi starts its model at: `modelThinkingLevels` for that model, else
  `defaultThinkingLevel`, else medium. A definition's `effort` overrides it,
  and so does `~/.pi/agent/subagents.json` for subagents alone, such as
  `{"thinking": {"<provider>/<model-id>": "high"}}`. The level is clamped
  to what the model can, and a resumed agent on another model gets that
  model's level unless its definition sets `effort`.
- `Explore` runs on `small` at medium effort, without the context files, and
  reports after at most 30 turns. A search of many steps costs a fraction
  there of what each step costs in a long conversation, and only the report
  comes back; the model is told to hand such searches to it. With Claude
  models `small` is Haiku. Claude Code's own `Explore` runs on the parent's
  model: a user agent named `Explore` with `model: inherit` does the same
  here.
- `maxTurns`: at the limit the subagent's step is stopped, and a message of
  its own asks for the report; a request that came beside a tool result could
  be taken for an injection. A subagent that calls tools again is stopped,
  and what it wrote last comes back marked as partial. Either way the report
  says that the limit was reached, and `resume` lets the subagent go on.
- Several `agent` calls in one response run in parallel.
  `run_in_background: true` returns at once; the report arrives later as a
  message that starts a turn, and the footer counts the running agents. A
  running foreground subagent can be moved to the background (Ctrl+B in
  [background-agents](#background-agents)); its `agent` call then returns at
  once in the same way. `resume` with an agent ID continues that subagent
  with its history. `fork: true` starts a new one with a copy of the
  conversation so far, up to the turn that makes the call; a fork starts no
  fork of its own.
- The `agent` call looks like Pi's own tools: the call as its title, while
  the agent works its latest two tool calls, afterwards the first line of
  the report with Pi's note on the hidden lines (Ctrl+O shows the tool
  calls and the whole report), and the figures last (tool calls, tokens,
  time, model, agent ID), as `bash` ends with `Took …`. The colour of the
  tool box shows the state. A background agent's report arrives as an
  `[agent]` block, as Pi shows `[skill]` and `[compaction]`: its first line,
  and the whole report on Ctrl+O or a click.
- A subagent runs as Pi in RPC mode and stays alive after its report: five
  minutes without work, three idle ones at most, the one used longest ago
  ending first. A `resume` or a message then continues it at once; later it
  starts again from its session file. `PI_SUBAGENT_IDLE_MS` sets another time,
  and `0` ends the process with its report.
- `/reload` keeps the subagents: the new runtime takes over their processes,
  their runs, and the finished ones. A background agent works on, stays in the
  panel, and its report arrives after the reload. A question a subagent has
  open at that moment is cancelled. Quitting Pi, `/new`, `/resume`, and `/fork`
  end the subagents.
- You can write to a subagent (from its transcript in
  [background-agents](#background-agents)). While it works it reads the
  message after its current step, and its report tells the model, in Pi's
  words, what you wrote. After its report the message starts it again, and
  its answer goes into the conversation without starting a turn. An interrupt
  stops what it is doing and leaves it waiting for your instruction, for five
  minutes; without one it counts as stopped.
- A subagent that keeps working by itself after its report, because a
  background agent of its own finished, is listed again, and what it writes
  then goes into the conversation the same way.
- Subagent sessions are stored in `~/.pi/agent/subagents/<session id>/` and
  deleted after 30 days. `/agents` lists the agent types and this session's
  subagents; `/agents stop <id>` stops a background one.
- A report reaches the model marked as the subagent's own words, so
  instructions in it carry no authority.
- The running and recently finished subagents are published on the event bus
  (`subagents:state`), where [background-agents](#background-agents) reads
  them; `subagents:stop` with an agent ID stops one, `subagents:interrupt`
  interrupts it, `subagents:message` with `{ agentId, text, images? }` writes
  to it, and `subagents:background` with an agent ID moves a running
  foreground one to the background.
- Other extensions extend the `agent` tool through the event bus: they emit
  `subagents:provider` with a `SubagentsProvider` — agent directories, a
  translation of tool names, model families, a default model, limits — at load
  and again on every `subagents:provider-request`, so the load order does not
  matter.

## claude-code-agents

Brings Claude Code's agent definitions and settings to the `agent` tool of
[subagents](#subagents), after
[Claude Code's subagents](https://code.claude.com/docs/en/sub-agents).
Without `subagents.ts` it does nothing.

- Definitions from `~/.claude/agents/` (`$CLAUDE_CONFIG_DIR/agents`), above
  `~/.pi/agent/agents/`, and from the trusted project's `.claude/agents/`, at
  every level up to the repository root, below that level's `.pi/agents/`.
- Tool entries in Claude Code's names (`Read`, `Bash`, `Glob`, …) and
  permission rules (`Bash(git *)`) name the matching Pi tools, in every
  definition, those in `.pi/agents/` included.
- `sonnet`, `opus`, `haiku`, and `fable` as a model resolve to the newest
  model of that family on the current provider; a family the current model
  belongs to keeps the current model. Each carries a tier of
  [subagents](#subagents): `haiku` is `small`, `opus` and `fable` are
  `large`, `sonnet` stays with the current model. A family the provider lacks
  falls back to its tier, and the tiers pick these families where the
  provider has them.
- `CLAUDE_CODE_SUBAGENT_MODEL` is the model when neither the call nor the
  definition names one. `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` (default 3) and
  `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS` (default 20) set how deep subagents
  nest and how many run at once.

## background-agents

The agent panel below the prompt, after Claude Code's: while subagents run, in
the background or in the foreground, the panel lists them, ↓ from the prompt
moves into it, Enter shows an agent's live transcript in place of the
conversation, and Ctrl+B moves a foreground agent to the background. Beyond
Claude Code, the prompt writes to the agent shown, and Esc interrupts it.

- The panel appears under the editor as soon as a subagent runs: a `main` row,
  then one row per agent, `type › description`, with its model and thinking
  level (`claude-haiku-5-5 · low`; without the maker, `haiku-5-5 · low`, where
  the descriptions would lose room), state, elapsed time, and tokens at the
  end, and a dimmed rule that sets it apart from the status line below. At
  most five rows are visible; the window follows the selection, with
  `↑ N more` and `↓ N more` for the rest. The state carries the colour: an
  agent that asks you, waits for your instruction, or waits for a usage limit in
  the warning colour, a completed one in green and dimmed, a failed or stopped
  one in red. Finished agents stay 30 seconds, then disappear. The footer reads
  `↓ to manage` while the panel exists. The selected row has an arrow (`→`), the
  accent colour, and the selection background, as in Pi's own lists and the
  `ask_user_question` dialog.
- ↓ on the last line of the prompt (not while browsing history or with the
  autocomplete open) selects the `main` row; the footer then says what the
  keys do. ↑/↓ move, ↑ from `main` returns to the prompt, Enter opens the
  selected agent (on `main` it shows the conversation again and returns to
  the prompt), `x` stops a running
  agent or clears a finished one, Esc returns to the prompt, and any typed
  character goes into the prompt. `/tasks` lists every agent the session
  still knows as a dialog, also the finished ones the panel no longer shows.
- An open agent replaces the conversation above the prompt, as in Claude
  Code; the prompt and the panel stay where they are. The view shows the
  agent's type, task, state, tokens, and model, then its transcript, drawn
  as Pi draws the conversation, with Pi's own components and your settings:
  the messages, thinking as you have it shown, each tool call in its box as
  the tool draws it (a diff for `edit`, the output of `bash` as it comes),
  collapsed as in the conversation; Ctrl+O expands and collapses them. Text,
  thinking, and tool arguments stream as the agent writes them. A tool of an
  extension is drawn as in the conversation once the conversation has drawn
  a call of it; until then it has Pi's plain form, its name and arguments.
  The view follows the end while the agent works
  and scrolls like the conversation (wheel, PgUp PgDn), beside the
  [diff](#diff) panel too. The panel shows the name of the agent or of
  `main` in bold, whichever conversation is shown; ↓ Enter (`main`) shows the
  conversation again, at the scroll position it had.
- While an agent is shown, the prompt writes to it. A working agent reads
  the message after its current step; until then it stands under the
  transcript as not read yet. A finished agent starts again with it and
  answers in its transcript and, as a note, in the conversation. Skill
  commands and prompt templates expand in the agent. A `!` command still
  goes to `main` and brings the conversation back.
- Esc on a working agent interrupts it: it stops what it is doing and waits
  for your instruction, while a foreground agent's `agent` call keeps
  waiting. Esc again stops it. Esc on an agent that does not work shows the
  conversation again. The line under the agent's state says what the prompt
  and Esc do right now.
- A row reads `asks you` while one of the agent's dialogs is open,
  `waits for you` after an interrupt, and
  `usage limit · continuing automatically at 19:01` while its run waits for a
  usage limit to reset ([auto-continue](#auto-continue)); Esc interrupts that
  wait as it interrupts work. The agent's report arrives in the
  conversation when it finishes.
- Foreground subagents (without `run_in_background`) are listed too; their
  tool call still shows their progress in the conversation. Ctrl+B moves them
  to the background, as in Claude Code: the one selected in the panel, or else
  every foreground agent. Its `agent` call returns at once, the conversation
  goes on, and the report arrives as a message when the agent finishes. While
  one runs, the footer adds `ctrl+b to run in background`; without a
  foreground agent, Ctrl+B stays the editor's cursor left.
- Background waits ([wait](#wait), [`gitlab_pipeline`](#gitlab_pipeline))
  are listed below the agents as agents are: the tool where an agent has its
  type, then what they wait for and what the last check found, and at the end
  their id, the time since they started (for a repeating wait, its interval),
  and their checks; `x` cancels one. Enter opens a box above the prompt, as
  the task manager shows a scheduled task: what the wait waits for and until
  when (a repeating wait: what it repeats and when it alerts), since when,
  when it gives up, its checks, its command, and the end of the last check's
  output, kept current while it runs. `x` cancels it there too,
  Esc closes the box.
- Scheduled tasks ([scheduled-tasks](#scheduled-tasks)) are listed below them,
  the same way: `scheduled`, their prompt, and at the end their id,
  schedule, and next run. Enter opens the task in the task manager, `x`
  deletes it. The panel also appears while only waits or tasks are there.
- In fullscreen mode the row under the pointer gets the arrow and the
  selection background, as in the `ask_user_question` dialog; when the pointer
  leaves the panel, the marker goes back to the row selected with the keys, or
  disappears while the prompt has the focus. ↑/↓, Enter, and `x` act on the
  row with the marker. A click on a row opens it, a click on `main` shows the
  conversation and returns to the prompt, and a click on `↓ to manage` in the
  footer moves into the panel. Pi tells a component nothing when the pointer
  leaves it, so the panel and the dialog watch the pointer's moves in Pi's
  fullscreen TUI; in a Pi version without that hook the marker simply stays
  where the pointer left it.
- The transcript comes from the agent's session file in
  `~/.pi/agent/subagents/<session id>/`. The swap exchanges the children of
  Pi's document container (the first component of its TUI, in fullscreen the
  content of the transcript's scroll view) and puts them back on return and
  when the session ends; Pi keeps writing to its own containers meanwhile.
  This is not a documented extension interface: when a Pi update changes that
  tree, the transcript opens in an overlay instead (↑↓ PgUp PgDn scroll, `x`
  stops the agent, Esc returns). The panel's keys come from a subclass
  of Pi's own editor set with `setEditorComponent`; an extension that replaces
  the editor as well wins over it, and the panel then has no keys.

## btw

`/btw <question>` asks the session's model about the conversation so far
without adding anything to it, like Claude Code's
[side question](https://code.claude.com/docs/en/interactive-mode#side-questions-with-%2Fbtw).

- It works while the agent is busy and does not interrupt it.
- No tools: the answer comes only from the conversation (sent as text, tool
  results cut at 20,000 characters, the newest 600,000 characters in all) and
  the earlier side questions.
- The answer streams into a box above the prompt; the conversation stays
  visible above it and keeps running. Space, Enter, or Esc closes it, Up/Down
  scroll, `[` and `]` step through earlier answers, `c` copies the answer, `x`
  clears the earlier ones. `/btw` alone reopens it. The thread lives until Pi
  exits. On `claude-bridge` the answer arrives whole: the provider runs a
  request with its own system prompt as a one-off Claude Code query.
- Every question sends the conversation to the session's provider again,
  without reusing its prompt cache, so it costs input tokens in proportion to
  the session's length.
- Side questions from the Claude app arrive through
  [claude-remote-control](#claude-remote-control) (`btw:ask` on the event bus)
  and are answered the same way, with the app's own earlier side questions;
  they do not join the terminal's thread.

## scheduled-tasks

Claude Code's
[session-scoped scheduled tasks](https://code.claude.com/docs/en/scheduled-tasks):
`/cron` and the tools `cron_create`, `cron_list`, and `cron_delete` (Claude
Code's `CronCreate`, `CronList`, and `CronDelete`).

- "Remind me at 3 pm to …" or "check the pipeline every 10 minutes" makes the
  model schedule a task with `cron_create` — a standard 5-field cron expression
  in local time, recurring or once. `/cron add|once <m h dom mon dow>
  <prompt>` and `/cron delete <id>|all` manage them by hand.
- `/cron` alone opens the task manager, a box above the prompt as `/btw`
  shows it (at most half the terminal high): the tasks by next run with their
  schedule in words (`daily at 11:00`, `every 15 min`, `once`) and prompt.
  ↑↓, the wheel, or the pointer select; Enter or a click shows a task with
  its cron expression, next run, creation and expiry, and the whole prompt;
  `x` or Delete deletes it; Esc goes back and closes. A click on
  `↻ … scheduled` in the footer opens it as well, and the
  [agent panel](#background-agents) below the prompt lists the tasks too.
  Outside the interactive terminal, and from the Claude app
  ([claude-remote-control](#claude-remote-control)), `/cron` answers with the
  list as text instead.
- Tasks fire only while the session is open and idle, between turns, without
  catch-up. Recurring tasks expire after seven days, and a session holds at
  most 50. They are stored in the session and restored on resume.
  `CLAUDE_CODE_DISABLE_CRON=1` turns all of it off.

## diff

`/diff` shows the changes the way Claude Code's
[diff panel and dialog](https://code.claude.com/docs/en/interactive-mode#review-changes-with-%2Fdiff)
do.

- In the fullscreen terminal, in a git repository, and with at least 110
  columns, it opens a panel beside the conversation that stays open while you
  work. The panel refreshes after every `edit`, `write`, and `bash` call and
  lists the changed files with their added and removed lines, each file's diff
  under the list. Test and generated files, and the changes from before this
  session, are folded into one line each.
- Mouse: click a file to jump to its diff; click `ask`, right of a file's name
  above its diff, to attach that diff to your next prompt (it reads `asked ✓`
  until you send it); click the source label to step through `Current` and the
  turn views; click the base label to switch between this session's changes,
  all uncommitted changes, and everything since the branch split from the
  default branch; click a folded line to unfold it, `✕` to close. The wheel
  scrolls.
- Keyboard: `alt+g` moves into the panel and back. There ↑↓ pick a file,
  PgUp/PgDn scroll, Tab switches the source, `b` the base, `a` asks, `e`
  unfolds, `r` refreshes, Esc returns to the editor, `x` closes.
- The panel opens on its own at the session's first edit when the terminal has
  144 columns, or 110 once you have opened it with `/diff`. Closed, it stays
  closed, in later sessions too, until `/diff` opens it again. `/diff` toggles
  it.
- Otherwise `/diff` opens a bordered block above the prompt with the same
  views: ↑↓ select, Enter opens a file's diff, `a` asks, Tab switches the
  source, `b` the base, `r` refreshes, Esc goes back and closes.
- `T1`, `T2`, … each show the edits of one prompt's run, from its `edit` and
  `write` calls; changes made through `bash` appear only under `Current`.
  "This session's changes" compares against the files as they were when Pi
  started, kept as temporary copies of the files that were already changed
  then.
- The panel state and the base per repository are stored in
  `~/.pi/agent/diff-panel.json`. The panel splits Pi's fullscreen layout with
  `tui.setLayoutRoot()`, which is not a documented extension interface: when a
  Pi update changes that layout, `/diff` falls back to the block above the
  prompt.

## claude-remote-control

`/remote-control`, also `/rc`, connects the session to claude.ai the way Claude
Code's [Remote Control](https://code.claude.com/docs/en/remote-control) does:
the Claude app (iOS, Android) and claude.ai/code show the conversation live,
and you can work on from there while Pi keeps running on your machine.

- `/rc [name]` connects. The first time, a dialog asks to enable Remote
  Control; the answer is kept in `~/.pi/agent/remote-control.json`. The
  session link and a QR code appear, the footer reads `⇄ /rc active`, and the
  link is noted in the transcript. `/rc` again opens the status panel with the
  link and the QR code; its last line names the keys: `d` disconnects, the
  local session goes on, and `Esc` keeps the connection.
  `pi --remote-control` connects at start, as does
  `"remoteControlAtStartup": true` in `~/.claude/settings.json` once Remote
  Control was enabled here.
- A session that was connected when Pi closed connects again when you open
  it, at start or with `/resume`, so a restart (or
  [tmux-pi-resurrect](https://github.com/dandjo/tmux-pi-resurrect) after a
  reboot) brings Remote Control back with it. The session records this in an
  entry the transcript does not show. Quitting Pi keeps it; disconnecting with
  `d`, or a connection that ends while Pi runs, clears it. Each reconnect
  opens a new remote session with a new link. `/reload` connects such a
  session too while it is not connected.
- A connect Pi makes by itself (at start, on reopening, with the flag or the
  setting) tries again when it fails for a reason that may pass: no answer, a
  failed name lookup or connection, or the server busy or failing for the moment
  (HTTP 408, 429, 5xx). It waits 5, 15, 30, and 60 seconds, and the footer shows
  the time of the next try (`⇄ /rc retrying at …`); `/rc` meanwhile connects at
  once. A rejected login (HTTP 401) is tried again once: right after a renewal
  the server can refuse the new token for a few seconds, as it did for several
  sessions that renewed the login together after a reboot. A second rejection in
  a row, and any other failure that will not pass (plan, policy), ends it, and
  `/rc` typed by hand tries once. When the server refuses a reconnect (plan,
  policy) or a login is rejected twice in a row, the session's record is cleared
  too, so it stops connecting by itself at every `/reload` or start. A failure
  names the step, creating the remote session or fetching its credentials, and
  the reason, which the extension reads from Node's HTTP diagnostics channels,
  since the bridge returns none. When a later try succeeds, the session log
  notes the first failure. A remote session that was created but could not be
  used is archived, and once more after five seconds when the server refuses
  that too.
- The session title is the name given to `/rc`, else the session's name (the
  one [session-title](#session-title) generates follows a little later), else
  the last prompt, else `<hostname>-<adjective>-<noun>`. A rename on either
  side reaches the other.
- From the app: send prompts, with photos and files (files are saved under
  the temp directory and named in the prompt), interrupt the run, pick the
  model (among the Claude models of the current provider), set the effort,
  rename the session. A prompt sent while Pi works enters at the next tool
  boundary, as Enter in the terminal does; only one the app marks `later`
  waits until the run ends. The app's model names resolve as Claude Code's do:
  `opus`, `sonnet`, `haiku`, and `fable` to the newest model of that family,
  a dated id to its model, and a context suffix such as `[1m]` is dropped. An
  effort level sets Pi's thinking level of the same name; Auto sets the level
  Pi starts the model with (`modelThinkingLevels`, else
  `defaultThinkingLevel`). An effort set from the app stays when the app then
  switches the model, as in Claude Code; without one, Pi's level for the new
  model applies. The app shows the current model and effort, also after a
  change in the terminal. The desktop app sends a model change at once; the
  mobile app sends the effort at once but the model only with its next prompt,
  so a model picked on the phone does not reach Pi while you type in the
  terminal, and the phone shows Pi's model again once it reconnects. There
  are no permission prompts to answer, since Pi has no permission modes.
- Context and usage, as Claude Code reports them: after every response the
  app's context indicator gets Pi's estimate of the tokens in use and the
  context window. The context card shows that estimate, the auto-compaction
  reserve, and the free rest, without Claude Code's breakdown by category.
  The plan limits (5-hour and weekly windows, model-scoped weekly windows,
  extra usage) come from [claude-usage](#claude-usage) and go out at connect
  and whenever they change. The usage card shows them with Pi's totals of the
  session: tokens and cost per model, time, and the lines changed by `edit`.
  Without `claude-usage.ts` the app gets no plan limits. The limit state
  follows the usage endpoint (warning while it grades a window warning or
  critical, rejected at 100 %), since Pi does not see the rate-limit headers
  Claude Code reads it from.
- Compaction, as Claude Code reports it: the app shows a compaction while it
  runs, then "Conversation compacted" with the tokens before and after, the
  summary, and the new context usage. Pi knows the context usage only after
  the next response, so until then the indicator and the context card show
  Pi's estimate of the compacted context. A manual `/compact` in the terminal
  is a turn of its own in the app, and the history shows earlier compactions
  at their place.
- Questions: an `ask_user_question` dialog opens in the app as well, as Claude
  Code's question card, and can be answered there or in the terminal. The app
  takes an answer only for a pending permission request, so the questions go
  out as one (`can_use_tool`), and the session shows as waiting for input while
  they are open. An answer from the app closes the terminal dialog. An answer
  from the terminal goes to the app and withdraws the card there, as do Esc and
  an interrupted run. Declining in the app with a note passes that note to the
  model. The app sends a multi-select answer as a list of labels, Claude Code
  as labels joined with `, `; both arrive with every label ticked.
- Slash commands from the app: Pi's built-ins that need no terminal UI run as
  if typed in the terminal — `/new` (also Claude Code's `/clear`), `/reload`,
  `/compact [instructions]`, `/name [name]`, `/model [name]`,
  `/thinking [level]`, and `/quit`; the remote session stays connected across
  `/new` and `/reload`. Each answers in the app with a short reply such as
  "Thinking level: low"; `/compact` answers with the compaction itself, or
  with the reason when there is nothing to compact. The other built-ins (`/tree`, `/resume`, `/fork`,
  `/settings`, …) need the terminal and get a reply saying so instead of
  reaching the model. Extension commands, skills, and prompt templates run as
  Pi commands — except `/cron`, which answers in the app: `/cron` with the
  task list, `/cron add|once …` and `/cron delete <id>|all` with what they
  did; in the terminal nothing opens. The desktop app turns `/name` and
  `/model` into a rename and a model switch of its own, with the same result.
- What the app sees: the conversation so far, then every prompt, assistant
  message, and tool call with its result, under Claude Code's tool names
  (`bash` as `Bash`, `edit` as `Edit`, …) so the app draws them as it does for
  Claude Code, and a result after each run. Thinking blocks are sent as they
  are. Side questions asked in the terminal (`/btw`), subagent transcripts,
  and the output of `!` commands are not sent.
- Side questions from the app: the app's `/btw` is answered by
  [btw](#btw), from the conversation and the app's own earlier side
  questions, and the answer appears in the app. It stays out of the
  conversation and out of the terminal's `/btw` thread.
- Background tasks: subagents appear in the app's task list as Claude Code's
  tasks do — started, progress (tool calls, tokens, the last tool) at most
  every three seconds, and how they ended — and the app's stop button stops a
  running one. Moving a running foreground agent to the background from the
  app (Claude Code's Ctrl+B) is not supported yet; in the terminal, Ctrl+B
  does it ([background-agents](#background-agents)).
- Transport: the Claude Agent SDK's bridge module
  (`@anthropic-ai/claude-agent-sdk/bridge`, marked alpha), which
  `pi-claude-agent-sdk` installs: under `~/.pi/agent/npm` or in a project's
  `.pi/npm`, wherever Pi put that package, the SDK in the package's own
  `node_modules` first, else the one npm hoisted beside it. It creates the
  session, mints a four-hour worker credential, and runs the event stream,
  heartbeats, and reconnects; the extension renews the credential five minutes
  before it expires and reconnects on its own after an outage. A new
  credential supersedes the transport it replaces, and the server ends that
  transport (close 4090) at its next request; while the extension mints one
  (a renewal, or attaching the bridge anew after `/reload` with new code),
  such a close is its own doing and does not end the connection. If another
  process takes the session over, the session ended, or the server rejects
  it, the connection ends with a notice.
- `/new`, `/resume`, `/fork`, and `/reload` keep the connection: the link
  stays valid, and the app goes on with the next session in the same remote
  session, as Claude Code does after `/clear`. The remote session keeps its
  title and gets neither the title nor the history of a resumed or forked
  session; a later rename still reaches the app. After a switch, the new
  session notes the link in its transcript. Pi loads the extensions afresh for the next session,
  so the connection is handed over through the process; prompts from the app
  that arrive during the switch wait for the next session. The bridge keeps
  the callbacks it was attached with, so when the extension's code changed in
  between (`/reload` after an update), the next session attaches the bridge
  anew in the same remote session: otherwise the bridge would take what the
  older code had no callback for, such as an answer to a question, and drop
  it.
- The SDK's bridge needs two repairs, which the extension makes in a copy it
  loads from `~/.cache/pi-remote-control/`, written fresh at the first `/rc`
  of every Pi process. A repair that no longer fits a new SDK release is left
  out, and `/rc` warns about it. The bundle is also checked without loading
  it, so the warning comes before you need Remote Control: at Pi's start and
  at `/reload` while a Claude model is active, at `/rc`, and right after
  [claude-sdk-update](#claude-sdk-update) installed a new SDK. Each bundle is
  warned about once per Pi process. The check only finds the places the
  repairs change, not whether the bundle still behaves as before, so `/rc`
  keeps its own warning. The repairs:
  - Its User-Agent names the SDK package version (`claude-code/0.3.308`), and
    the server takes that for Claude Code 0.3.308: the app refused newer
    models such as Fable 5.1 with "Claude Code 0.3.308 does not support this
    model". The copy sends the Claude Code version the SDK ships with
    (2.1.308), as Claude Code does.
  - `attachBridgeSession` does not hand the effort change, the context usage
    request, the usage request (`get_usage`), or the current model on to the
    part that answers the app, so every effort change, context usage and usage
    request failed with "not supported in this context". The copy passes all
    four on.
- Login: a claude.ai OAuth token with the `user:sessions:claude_code` scope:
  Pi's own Anthropic login (`/login`, Anthropic (Claude Pro/Max)), the one the
  `claude-bridge` provider runs on. An Anthropic API key cannot open Remote
  Control sessions; `/rc` then says so. The token is read fresh for every
  request and never refreshed here. Remote Control needs a Claude model:
  without one, `/rc` declines, and switching to another model disconnects.
  Remote Control needs a Pro, Max, Team, or Enterprise plan; on Team and
  Enterprise an owner must allow it in the Claude Code admin settings.
- Overnight: Pi renews a login that ran out before it hands it over, so the
  four-hourly renewal of the connection works after hours without a prompt
  too. A renewal that keeps failing for five minutes goes into the session log
  with its reason, and so does the reconnect after it.
- While connected, the conversation is stored on Anthropic's servers under the
  claude.ai data policy; execution and files stay on your machine, and the
  session only makes outbound HTTPS requests. Disconnecting and quitting
  archive the remote session.
- `pi-claude-agent-sdk` 0.12.1 pins SDK 0.3.321;
  [claude-sdk-update](#claude-sdk-update) installs a newer one, which loads at
  the next start or `/reload`. The bridge API is not a public interface and
  can change with any SDK release.

## claude-sdk-prices

Puts a price on the replies of `claude-bridge`. `pi-claude-agent-sdk`
registers its models with every price at 0, because a Claude subscription is
not billed per token. Pi computes the cost of a reply from the model's prices,
so the status line, the subagents panel, and every reply showed $0, and
[subagents](#subagents) offered no model ladder, which needs a price for every
rung.

- At the start of a session, and before a prompt to a model still without a
  price, each `claude-bridge` model gets the prices of the model with the same
  id at the provider `anthropic` (Pi's catalog: input, output, cache read,
  cache write, and the tiers above a context size). Pi then takes the priced
  model for the next reply.
- These are Anthropic's API list prices: what the tokens would cost on the
  API, not what the subscription costs. Replies before it ran keep $0.
- A model without a twin at `anthropic` keeps 0; with any other provider it
  does nothing.

## claude-sdk-rules

Gives Claude the rules of Pi's system prompt. `pi-claude-agent-sdk` runs Claude
Code with its own system prompt and appends only the portable parts of Pi's:
context files, skills, a custom prompt, appended text, and the sections
extensions add. Pi's `<rules>` are not among them, and with them every
guideline the tools bring: Claude sees each tool's description, but not when
to use it, or not.

- While a `claude-bridge` model runs, it builds the rules as Pi does and adds
  them as the section `rules`. That section takes the place of Pi's own rules
  with the same text, so Pi's prompt stays as it was, and the provider passes
  it on.
- The rules change only with the tools and their guidelines, so the prompt
  stays the same from turn to turn and the provider keeps its Claude Code
  session.
- A guideline that an extension loaded after this one adds at run time is
  missing; `bash-timeout.ts` loads before it.
- With a custom prompt (a `SYSTEM.md` of your own), which has no rules in Pi
  either, and with any other provider it adds nothing.

## claude-sdk-stream-only

Keeps a stalled response from hanging the run. When a streamed response
stalls, Claude Code repeats the request without streaming and gets the answer
as one finished message per content block, without stream events.
`pi-claude-agent-sdk` passes such an answer on, but ends Pi's response at its
first tool call, so of parallel tool calls only the first reaches Pi: the
others wait for Pi while Pi waits for the answer, until the run is aborted.

- Sets `CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK=1` in Pi's own environment,
  which the provider hands to every Claude Code process it starts. A stalled
  stream then ends as a retried stream or as an error, and both reach Pi.
- Applies to Pi alone, not to the shell. A value set before Pi starts is
  kept.
- Claude Code processes started before the extension was loaded keep their
  environment; start Pi anew to apply it.

## claude-sdk-update

Keeps the Claude Agent SDK of `pi-claude-agent-sdk` current. The SDK brings
Claude Code along, and Claude Code takes each model's context window from a
list built into it: a model newer than the bundled Claude Code counts as 200k,
so Claude Code refuses a longer session with "Prompt is too long" before any
request, although the model takes 1M. The package pins the SDK to one exact
version, so `pi update` brings a newer one only with a release of the package.

The extension installs a newer SDK through an npm override in the
`package.json` of Pi's npm root (`~/.pi/agent/npm`):
`"overrides": {"@anthropic-ai/claude-agent-sdk": "0.3.332"}` makes npm install
that version in place of the pinned one. Pi creates that file only when it is
missing, and npm keeps the field, so the override outlasts `pi install` and
`pi update`. Only the SDK is overridden; its packages with Claude Code follow
it.

- At every start in the terminal, Pi compares the SDK that
  `pi-claude-agent-sdk` uses with the npm registry's latest version, in the
  background. Print, JSON, and RPC mode, subagents, `PI_OFFLINE`, and an npm
  root without `pi-claude-agent-sdk` skip the check.
- A newer version is installed right away: the override is set to it, or
  raised, never lowered, and `npm install --legacy-peer-deps` runs as Pi
  installs its packages: without the flag, npm would install Pi itself as a
  peer dependency. A notice names the old and the new SDK and Claude Code
  version, and Pi processes started from then on use them. Running sessions
  keep the SDK they loaded; start them anew. When the install fails and the
  SDK stayed as it was, `package.json` is put back as well.
- `/claude-sdk-update` (also `/claude-sdk-update latest`) checks and installs
  at once and reports the state: the installed SDK, the version the package
  pins, and the override.
- `/claude-sdk-update pinned` removes the override and installs the version
  the package pins again, and turns the update at the start off: it is
  remembered as `{"auto": false}` in `~/.pi/agent/claude-sdk-update.json`, so
  the next start does not set the override again. `/claude-sdk-update` or
  `/claude-sdk-update latest` turns it on again and updates.
- A check outlasts a session replaced while it runs (`/new`, `/resume`,
  `/fork`, `/reload`): its notices and the event below go to the session
  current when it ends.
- After an update, also one back to the pinned version,
  `claude-sdk-update:installed` on Pi's event bus carries the new SDK's folder
  and versions, and [Remote Control](#claude-remote-control) checks its
  repairs against the new bundle at once.
- Pi processes starting together update one at a time, through a lock file
  in `~/.pi/agent/npm`.
- Claude Code stays startable during the update. npm writes a package into
  its place file by file, and an executable of a few hundred MB can be
  neither found nor started for the seconds that takes (`spawn ETXTBSY`). So
  the new version is installed into a folder beside `node_modules` first, and
  its packages, complete, take the place of the old ones with a rename each;
  `package-lock.json` gets their entries, and the `npm install` that follows
  finds them in place and only settles the rest. Where the folders cannot be
  renamed (Windows, while Claude Code runs), `npm install` installs in place,
  and a request that starts Claude Code just then fails and can be repeated.
- npm skips an optional package it cannot fetch without an error, and the
  packages with Claude Code are optional. When the folder beside
  `node_modules` lacks one that is installed now, nothing is moved and
  nothing changed: the installed SDK and the override stay, the notice names
  the package, and the next start tries again. After an update, every one of
  these packages installed before must still be there; a missing one is
  reported with the command that installs it again (`npm install
  --legacy-peer-deps --no-audit --no-fund` in `~/.pi/agent/npm`), since
  without it Claude Code may not start.
- Works with npm, Pi's default. With an `npmCommand` setting for pnpm or Bun,
  the extension does nothing.

## network-resilience

Keeps a request alive through network trouble the way Claude Code does. Pi on
its own retries three times within 14 seconds and shows nothing while a
request hangs. Through `pi-claude-agent-sdk`, Claude Code's own retries stay
invisible too, because the provider drops their messages: Pi says "Working…"
for as long as Claude Code retries, twenty minutes and more when its connects
time out.

- After 20 seconds without stream data, the working message counts the wait
  and says whether the API host answers, as Claude Code's "Waiting for API
  response · check your network" does. The check is a TCP connect to the
  model's API host (`api.anthropic.com` for `claude-bridge`), through
  `HTTPS_PROXY` when one is set. A provider without an http(s) base URL other
  than `claude-bridge` is not checked unless `probeHost` names a host for it.
- While the host does not answer, the message names the cause in Claude
  Code's words ("no route to api.anthropic.com (ENETUNREACH) · check your
  connection or VPN"), and the footer shows `⚠ offline`.
- A request that gets no data after the network came back, after the machine
  woke from sleep, or after the network interfaces changed (a VPN coming up,
  Wi-Fi to cable; not the bridges of containers and virtual machines, WSL
  included) is aborted 10 seconds later and the run resumes: a note in
  the transcript tells the model the response was lost. Data in the first 5
  seconds after a change does not count: it can be the last bytes of a
  connection the change already cut.
- An interface changes when an IPv4 address or an IPv6 /64 prefix comes or
  goes. IPv6 privacy addresses rotate within their prefix every day without
  cutting a connection, so they do not count, and neither do link-local
  addresses.
- Linux notices sleep after 5 seconds. On macOS and Windows the clocks run on
  while the machine sleeps, so only a sleep of more than 60 seconds shows
  there; a Pi that hung for a few seconds is no sleep.
- A change also concerns the requests that start after it, until data comes
  through. Claude Code sends them over a connection opened before the change,
  which never answers, and gives up on it only after three to four minutes.
  Such a request is restarted after 30 seconds without data, once per change.
  When the last response is older than the prompt cache lives
  (`cacheWarmMinutes`), the cache is cold and the API reads the whole context
  first, which took Claude Opus up to 42 seconds: then the restart waits 60
  seconds.
- A request silent for 5 minutes while the host answers is restarted too. At
  most three restarts follow each other without a response in between.
- Before every request that follows a connection error, Pi's own retries
  included, the host is checked. While it does not answer, Pi waits and checks
  every 3 seconds instead of spending its retries, for up to 30 minutes per
  outage; Esc interrupts the wait.
- The attempts themselves are Pi's: with `retry.maxRetries` 10 and
  `retry.maxAgentDelayMs` 32000 in `~/.pi/agent/settings.json` (step 2 of the
  setup) Pi retries a transient error ten times with a backoff from 2 up to
  32 seconds, close to Claude Code's ten. [auto-continue](#auto-continue)
  waits out a usage limit, and a rate limit once Pi gives up on it.
- Settings, all optional, go into `~/.pi/agent/network-resilience.json`:
  `noticeSeconds` (20), `graceSeconds` (10), `stallSeconds` (300; 0 turns
  the silence restart off), `maxRestarts` (3),
  `offlineWaitMinutes` (30; 0 turns the waiting off), `cacheWarmMinutes`
  (5, Anthropic's default; 60 on `claude-bridge`, whose cache lives an hour),
  and `probeHost` (`host:port` to check instead of the API host). Under
  `providers`, each of them can be set for one provider and wins there over
  the top level: `{"providers": {"openai": {"cacheWarmMinutes": 10}}}`.
- When the API delivers data while the check fails, the check does not
  reflect your network, behind a proxy Pi does not know of, for example.
  Checking then stops until Pi restarts, and restarts after a disruption
  follow the 10 seconds alone. Set `probeHost` to a host that answers.

## auto-continue

Waits out a used-up usage limit, quota, or rate limit and continues the run
after the reset, as Claude Code does with `autoContinueAtUsageLimit`, for any
provider. Without it, a request that hits such a limit ends the run: Pi
retries a rate limit a few times, but does not wait out a limit of hours or
days — Claude Code's
`You've hit your session limit · resets 7pm (Europe/Vienna)`, Codex's
`You have hit your ChatGPT usage limit (plus plan). Try again in ~123 min.`,
a daily quota of Gemini or Groq — and nothing goes on after the reset until
you send a prompt.

- The failed request leaves the model's context, as with Pi's own retry, and
  a note joins the conversation: when the limit was reached, when it resets,
  and that the model is to continue without repeating finished work. The run
  stays active, and its next request waits until the reset. The working line
  shows the time,
  `Usage limit reached · continuing automatically at 19:01 (in 3h 29m)`, and
  Esc ends the run as ever. Meanwhile the spinner is hidden and the line
  changes once a minute, so the waiting session does not redraw the screen
  many times a second for hours.
- The reset time comes from what the provider says, the first found of:
  - the error text, in its common forms: a clock time in the time zone it
    names, else the local one (Claude Code, Codex's `try again at 4:12 PM`),
    a duration after "try again in", "retry after", or "resets in"
    (`7m54.24s` from OpenAI and Groq, `~123 min` from Codex,
    `86400 seconds` from Azure, `19h14m47s` from Gemini CLI), Gemini's
    `retryDelay`, and Pi's `Server requested 3600s retry delay`, in which Pi
    passes on a `retry-after` header that extensions do not see;
  - the headers of the refused response, where the provider's transport
    hands them to extensions (Codex does; the Anthropic and OpenAI SDKs throw
    before): `retry-after`, `anthropic-ratelimit-unified-reset`,
    `x-ratelimit-reset-*`, `ratelimit-reset`, and Codex's
    `x-codex-primary-reset-at`, a used-up window's first;
  - the plan's limits, where an extension offers them for the model, as
    [claude-usage](#claude-usage) does for Claude: the latest reset among the
    windows used up.

  Rarer forms are not read — a day with a UTC time (Anthropic's spend
  limits), Z.ai's time without a zone, ISO or epoch times in the body of the
  error (OpenRouter), Gemini's daily quota: such a limit is tried again at
  the intervals below. A clock time is waited for plus a minute and up to
  half a minute more, so the sessions of one account do not all start at the
  same second.
- Without a reset time, a usage limit or quota is tried again after 2, 5, 10,
  15, and 30 minutes, then every hour. A plain rate limit (`429`,
  `rate limit`, `too many requests`) is left to Pi's own retry first; once Pi
  gives up on it, it is tried again the same way, or waited for when it names
  a reset.
  Credit and billing errors (`insufficient credits`, `payment required`,
  OpenAI's `You exceeded your current quota`) do not reset by themselves and
  stand as they are.
- While the run waits, the plan's limits are asked every five minutes, and
  once a used-up window is free again, the run continues early.
- Whatever starts a run while the limit holds waits the same way after its
  first failed request: a subagent's report, the result of a background
  wait, a message from another session, and a scheduled prompt.
  Subagents load the extension in their own Pi process, so they wait
  and continue by themselves, also while the main session is idle. Their row
  in the [agent panel](#background-agents) shows the wait, and the tmux tab
  rests meanwhile ([tmux-tab-activity](#tmux-tab-activity)): in RPC mode,
  where Pi draws no working line, the wait is the status entry
  `auto-continue:wait`, which [subagents](#subagents) reads. Messages that
  arrive during the wait are queued and reach the model when the run
  continues.
- A request that hits the limit again right after the wait waits again, at
  least two minutes. After three such hits in a row the named reset is no
  longer trusted (Gemini names one of seconds for a used-up daily quota), and
  the run tries again at the intervals above. A reset more than eight days
  away, or tries over eight days, end the waiting with a notice.
- A compaction that fails on a limit — `/compact`, or Pi's own when the
  context fills up or overflows — is tried again once the limit resets, with
  the reset worked out as above. Pi itself tries a failed compaction again
  only before the next request of a run, and an idle session stays as it is.
  The retry waits until Pi is idle, since a compaction ends a running run,
  and goes as `/compact` with the instructions the failed one had. After one
  that a context overflow started, the run that overflowed continues with a
  note. Meanwhile the status line shows
  `⧗ compaction at 11:41 (in 7m) · esc cancels`. Esc in an empty editor, a
  prompt, or another compaction that succeeds ends the wait. The wait
  outlasts `/reload`, not a restart of Pi; a context over the threshold
  compacts with the next run anyway.
- If Pi ends during the wait (a reboot, `/quit`), the wait resumes when the
  session starts again before the reset; after the reset, a notice says to
  send a prompt. Esc during the wait is remembered as Esc: the session does
  not wait again on its next start.
- The [tmux tab](#tmux-tab-activity) rests while a run waits.

## compaction-cut

Places the cut of a compaction by measured token counts. A compaction keeps
the most recent part of the conversation as it is, `keepRecentTokens` (20,000
by default), and Pi finds that point with an estimate: four characters per
token, and only the thinking it can see. With Claude, German text, JSON and
code run nearer three characters, and Opus shows next to none of its
thinking, which the API counts all the same: in a measured session Pi's cut
kept 75k tokens instead of 20k, and the first request after the compaction
wrote them all to the prompt cache again.

- Every response carries the real size of the request that produced it. The
  growth from one response's request to the next is the real size of what
  lies between them: the response with its thinking, and the tool results and
  messages after it. It shares that growth out over those entries; where no
  such measure holds (a compaction or a model switch in between, a request
  that shrank), an entry keeps its estimate.
- It walks back from the end as Pi does, to the point where
  `keepRecentTokens` is reached, and moves the cut there when that keeps less
  than Pi's own cut. It changes the compaction Pi prepared, so Pi's summary,
  or [idle-compaction](#idle-compaction)'s, covers exactly the part that goes.
  It never keeps more than Pi would.
- It acts on `/compact`, the `compact` tool, and the threshold. A compaction
  that recovers from an overflowing context stays as Pi prepared it.

## idle-compaction

Compacts a long conversation you left idle, as the Claude Code desktop app
does. Every request keeps the prompt cache warm, and Claude's lives an hour;
the first message after that writes the whole context to the cache anew, at
the price of the whole context.

- A conversation of at least 100k tokens that stays idle for 50 minutes after
  its last request is summarised in the background with Pi's own summariser,
  on the session's model. The session stays free meanwhile.
- Your next message after an hour without a request compacts the session with
  that summary before it goes out, so it carries the small context only. If
  the summary is still being written, the message waits for it. A message
  within the hour, while the cache still holds the conversation, drops the
  summary unused.
- The summary covers the whole conversation; Pi keeps its recent messages as
  they are, as with `/compact`. A summary of a conversation that changed
  meanwhile, by a background result or a message, is dropped.
- After a start or `/reload`, the time of the last request comes from the
  session, so a conversation idle long enough already is summarised at once.
- It works in the interactive session only: a subagent ends with its run, and
  so does print mode.
- Settings, all optional, in `~/.pi/agent/idle-compaction.json`: `enabled`
  (true), `minTokens` (100000), `prepareMinutes` (50), and `coldMinutes`
  (60). Under `providers`, each of them can be set for one provider and wins
  there over the top level, for a provider whose cache lives shorter:
  `{"providers": {"openai": {"prepareMinutes": 5, "coldMinutes": 10}}}`.

## compact

Adds the `compact` tool, with which the model compacts the session on its
own, as `/compact` does for you: when a part of the work is done and its
details are no longer needed, before the next part fills the context further.

- `focus` (optional) says what the summary must keep: the task, decisions,
  open steps, paths. It goes to the summary as `/compact <instructions>`
  would.
- The call ends the run after its tool batch, as Pi's compaction would abort
  a run that goes on. Once Pi is idle, the session is compacted, and a
  message then starts a turn in which the model continues the task from the
  summary.
- A compaction that fails (nothing to compact yet, a usage limit, …) lets the
  model continue all the same, with the error in the message. Esc during the
  compaction or the run, or a message from you meanwhile, drops the
  continuation: you take over.
- The model must compact at two points: when you turn to a new task
  unrelated to the finished one, and when a finished part of a long task
  leaves outputs behind (logs, file contents, search results) that the next
  part does not need. It skips it only while the session is short or in the
  middle of a step. For a new task, `focus` carries your request in your
  words.
- It declines, and the model goes on with the task, in a run that started
  after an hour without a request or right after a compaction. The first
  request of such a run has rebuilt the prompt cache already, and
  [idle-compaction](#idle-compaction) compacts a large conversation before
  it; a compaction would add a summary and a second rebuild.
- It works in the interactive session only: a subagent ends with its run, and
  so does print mode.

## wait

Adds the `wait` tool: it waits for something to happen — a CI pipeline, a
deploy, a container coming up, a file appearing — without model requests. A
model that polls on its own sleeps in bash and checks again, and every check
is a request that reads the whole context.

- `wait` runs a shell command (`command`), or calls another tool (`tool` and
  `args`: `gitlab`, `openproject`, `web_fetch`, …), every `interval` seconds
  (30) until the condition holds, for at most `timeout` minutes (30). The
  first check runs at once.
- `until` is `match` (the output matches the regular expression `match`, the
  default when it is given), `nomatch` (no longer matches), `success` (exit 0,
  or the tool call succeeds; the default otherwise), `failure`, or `change`
  (the output differs from the first check).
- `needResult` is required: the model says each time whether its next step
  needs the result. Left to choose, models wait in the foreground out of
  habit and do nothing meanwhile. The guidelines say `true` only when the
  very next step depends on the result and nothing else is left to do.
- `needResult: false` returns at once, and the model goes on with what does
  not depend on the result, or ends its turn. When the condition holds or the
  wait gives up, a message brings the result into the conversation: while Pi
  works, with its next step; when Pi is idle, it starts a turn. `/waits` and
  the tool's `list: true` list the background waits, those of
  [`gitlab_pipeline`](#gitlab_pipeline) too; `/waits cancel <id>` or the
  tool's `cancel` stops one.
- That message takes one line: the wait's id and purpose on the left, on the
  right how it ended (`✓`, `■ timeout`, `! alert`), the shell's exit code,
  the checks, and the time, as in
  `[wait] w3 Reload the companion   ✓ exit 0 · 1 check · 2s`. A click or
  Ctrl+O shows its whole text; the model gets all of it in any case.
- `needResult: true` waits in the foreground: the call returns when the
  condition holds, with the last output; the tool row counts the checks
  meanwhile, and Esc stops it. When you send a message meanwhile, or after
  five minutes without a result, the wait goes on in the background with the
  checks it made, the [agent panel](#background-agents) lists it, and the
  result comes as a message; a model that needs it ends its turn until then.
- A wait for a tool calls the tool through the runtime it started in, so a
  `/reload` ends it, and a message says so.
- Without a terminal, in a subagent or in print mode, every wait is in the
  foreground: nobody would take a result that comes after the run.
- `repeat: true`, for shell commands, is for background work that recurs,
  such as a keepalive or a token renewal: the command runs every `interval`
  seconds until the wait is cancelled or the session ends (a `timeout` only
  when given). The condition, `failure` by default, raises an alert: a
  message comes when it holds, the wait goes on, and the next alert comes
  only after a check where it did not hold. The model is told to use it
  instead of `nohup` or `&` in bash, so the work shows in the
  [agent panel](#background-agents) and you can stop it there.
- Background waits go on over `/reload`, and a result that comes while Pi
  reloads arrives once it has. Another session (`/new`, `/resume`, `/fork`)
  ends them, as they belong to the conversation that started them, and names
  them in a notice. The [agent panel](#background-agents) lists them, and
  [tmux-tab-activity](#tmux-tab-activity) turns its slow spinner for them,
  except for repeating ones; both learn of them on the event bus
  (`background-waits:state`).
- The model is told to wait only for what has not happened yet. A check whose
  condition should already hold, such as a container that just answered,
  stays a single bash call.
- A GitLab pipeline or job is a case for
  [`gitlab_pipeline`](#gitlab_pipeline) with `action: "wait"`. Without it, a
  pipeline goes through the `gitlab` tool, so the token stays with it:
  `{tool: "gitlab", args: {path: "/projects/<id>/pipelines/<pipeline>"},
  match: "\"status\": \"(success|failed|canceled)\""}`.
- A bash call that sleeps 15 seconds or more right after another bash call
  that did is refused, with a pointer to `wait`; running it again goes
  through. `{"nudge": false}` in `~/.pi/agent/wait.json` turns that off.

## bash-timeout

Gives the bash tool a default timeout, as Claude Code has. Pi runs a command
without a time limit unless the model gives one, so a command that never ends
holds the session until you press Esc: a test script that left its browser
open ran for 42 minutes.

- A bash call without `timeout` stops after 120 seconds, as in Claude Code;
  Pi ends the command with everything it started. A call with its own
  `timeout` keeps it. `pi-claude-agent-sdk` sets 120 seconds of its own on a
  call without one; the setting below takes its place.
- The model learns of the default from a guideline for the bash tool, so it
  gives `timeout` itself for a build, a test run, or an install that takes
  longer. Pi puts it into its prompt's rules, and a `SYSTEM.md` of your own
  into its list of guidelines when it has one. `pi-claude-agent-sdk` hands
  Claude Code only parts of Pi's prompt (context files, skills, appended
  text), not its rules, so its models, like a `SYSTEM.md` without such a list,
  go without, and the hint below tells the model.
- A call the default stopped comes back with a hint: run it again with the
  timeout it needs, use [wait](#wait) for something that has not happened
  yet, or close the process that did not end, such as a browser or a server.
- `{"seconds": n}` in `~/.pi/agent/bash-timeout.json` changes the default;
  `0` turns it off. Your own `!` commands are not tool calls and run without
  a limit.

## Small model

`session-title.ts` and `web-tools.ts` carry the same code that picks the
model for side tasks — session titles and `web_fetch` answers — for whatever
provider and model are in use:

- Among the models of the current model's provider that have working
  credentials and read text, it takes the one with the lowest list price (input
  plus output per million tokens), if that is cheaper than the current model.
  Otherwise it keeps the current model. With `claude-bridge` or `anthropic`
  that is Claude Haiku 5.5, with `openai` currently `gpt-5-nano`.
  `claude-bridge` lists its models without a price;
  [claude-sdk-prices](#claude-sdk-prices) gives them Anthropic's.
- A side task never moves to another provider or account, so prompts and page
  text only go where the conversation already goes.
- On providers that serve several makers' models and name the maker in the id
  (`anthropic/claude-…` on OpenRouter, `us.anthropic.claude-…` on Bedrock),
  only models of the current maker qualify.
- A current model without a price (local models, unknown prices) is kept.
- Thinking is off, or as low as the model allows. A model that cannot switch it
  off (Claude Haiku 5.5) gets 4,096 output tokens on top of the answer's limit,
  because its thinking counts against it. Without them, a session title
  (100 tokens) sometimes failed with "Claude's response exceeded the 100 output
  token maximum".
- `PI_SMALL_MODEL=<provider>/<model-id>` overrides the choice.
- Side requests give up after two minutes and run at once, on every
  provider.
- The `small` tier of [subagents](#subagents) takes the same model where the
  provider has no small model family of its own.
- Through `claude-bridge`, a side request carries its own short system prompt
  instead of Claude Code's: the provider runs it as a one-off Claude Code query
  without tools and without a stored session. With the earlier provider and
  extra usage switched off, Anthropic counted such a request against the
  subscription; with `claude-bridge` that is not tested yet, and the provider
  warns when Claude Code reports a request billed to extra usage.

## Web search

`web_search` comes from the npm package
[pi-web-access](https://github.com/nicobailon/pi-web-access), pinned to 0.44.0,
together with `source_check` (evidence for a claim) and `get_search_content`
(the full stored results of a search).

- Pick a search provider as the package's README describes and put its
  settings into `~/.pi/agent/web-search.json`. Without one, the package uses
  Exa's public endpoint, an external US service.
- Next to the provider, these settings help:
  - `"webSearch": {"allowedProviders": ["<your provider>"]}` admits no other
    search provider, so a query never falls back to another one. Even a call
    that names another provider is refused.
  - `"tools": {"fetchContent": {"enabled": false}}` drops the package's
    `fetch_content`, so `web_fetch` is the only tool that reads pages and the
    model does not choose between two.
  - `"toolActivation": "eager"` offers `web_search` from the first request. By
    default the package may add it only after the model calls `web_enable`;
    tools added mid-session can cost a prompt-cache miss, and with
    `claude-bridge` a new Claude Code process.
- The package's defaults stay: no summary model call (`workflow: "none"`), no
  browser cookie access, a guard against fetching private addresses, and a
  one-hour cache of results in Pi's config directory.
- To update, read the package changelog and run
  `pi install npm:pi-web-access@<version>`.

## Browser control

- [chrome-devtools-mcp](https://github.com/ChromeDevTools/chrome-devtools-mcp)
  from the Chrome DevTools team gives the model 32 tools: open, switch, and
  close tabs, navigate, read a page as an accessibility snapshot, click, fill
  forms, press keys, take screenshots, read console messages and network
  requests, record performance traces, and run Lighthouse audits.
- `--autoConnect` attaches to the Chrome you are running, with your logins.
  With several Chrome profiles it takes the one Chrome treats as its default.
  Without the flag the server starts a Chrome of its own with a separate
  profile in `~/.cache/chrome-devtools-mcp/chrome-profile`; `--isolated` makes
  that profile temporary.
- The server sees every open tab of that profile. Tab titles and URLs reach the
  model with each tab action — mail, messengers, and client systems included.
  For confidential work, give the agent a Chrome profile of its own.
- `--no-usage-statistics` and `--no-performance-crux` stop the server from
  sending usage data to Google and the URLs of performance traces to the CrUX
  API. Keep both.
- `@latest` makes `npx` fetch the newest release at every start.
- `"exposure": "deferred"` keeps the 32 tools out of the context until
  `tool_search` loads the ones a task needs; the model then calls them
  directly, and screenshots and snapshots reach it as they are. With Pi's
  default, `codemode`, only scripts could call them. `--slim` is no
  alternative: it leaves only `navigate`, `evaluate`, and `screenshot`.
- [Playwright MCP](https://github.com/microsoft/playwright-mcp) from
  Microsoft adds a second browser, headless and with a fresh profile in memory
  (`--isolated`): no logins, no tabs of yours, nothing kept between sessions.
  It suits pages that need JavaScript, where `web_fetch` reads an empty page,
  and anything the model may click through without your accounts; your
  Chrome stays for pages behind a login or a bot challenge, which a headless
  browser meets more often. Its 25 tools navigate, click, fill forms, press
  keys, read a page as an accessibility snapshot, and take screenshots.
- It runs on your machine and reaches what your machine reaches, the VPN
  included. Playwright states that it is no security boundary, so it runs
  locally for each user rather than as a shared server: a browser on a
  server would reach the services in its networks past their allowlists and
  logins.
- It starts the installed Google Chrome. Without one, run
  `npx @playwright/mcp install-browser chrome-for-testing` and add
  `"--browser", "chromium"` to its `args`.
- `--output-dir` keeps the snapshots and screenshots it saves as files in
  `~/.cache/playwright-mcp`; without it they land in `.playwright-mcp/` of
  the project Pi works in. The model gets a link to each snapshot and reads
  the file when it needs it. `@latest` and `"exposure": "deferred"` work as
  for chrome-devtools-mcp.

## License

[MIT](LICENSE).

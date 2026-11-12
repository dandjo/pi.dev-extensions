# Pi extensions

Extensions for [Pi](https://pi.dev), the terminal coding agent, that bring
over what Claude Code does: Pi runs Claude models on your Claude subscription,
shows a status line with the subscription limits, draws tool calls as compact
teasers, searches and reads the web, keeps a memory per project as Claude Code
does, titles every session, lets sessions message each other, runs Claude
Code's hooks, brings over Claude Code's subagents, questions, side questions,
goals, loops, scheduled prompts, diff view, agent panel, and Remote Control
for the Claude app, reads and changes OpenProject and GitLab, reads and writes
the clipboard, controls your Chrome, keeps requests alive through network
trouble, and keeps the Claude Agent SDK current.

The repository mirrors `~/.pi/agent/`: a file at `extensions/<name>.ts`
belongs at `~/.pi/agent/extensions/<name>.ts`.

| Extension                  | What it does                                                                              | Needs                                                            |
| :------------------------- | :---------------------------------------------------------------------------------------- | :--------------------------------------------------------------- |
| `claude-marketplaces.ts`   | Loads the plugins of Claude Code marketplaces into Pi and keeps them current              | Git access to each marketplace                                   |
| `statusline.ts`            | Replaces Pi's footer with a Claude Code style status line, for any provider               | —                                                                |
| `claude-usage.ts`          | Adds the Claude subscription limits and usage credits to the status line                  | `statusline.ts`, a Claude subscription login (Pi or Claude Code) |
| `compact-tools.ts`         | Draws every tool call as a teaser, as Claude Code does; Ctrl+O shows all of it            | —                                                                |
| `web-tools.ts`             | Adds `web_fetch`: reads a page locally and lets a small model answer from it              | —                                                                |
| `openproject.ts`           | Adds `openproject`: reads and changes OpenProject through its API v3, as you              | An OpenProject API token for each instance                       |
| `gitlab.ts`                | Adds `gitlab`: reads and changes GitLab through its REST API v4 and GraphQL, as you       | A GitLab personal access token for each instance                 |
| `clipboard.ts`             | Adds `clipboard`: the model reads and writes the clipboard, text and images               | Linux: `wl-clipboard` (Wayland) or `xclip`                       |
| `memory.ts`                | Keeps a memory per project, shared with Claude Code's auto memory when it is there        | —                                                                |
| `session-title.ts`         | Names each session after its first prompt and shows it in the terminal title              | —                                                                |
| `session-socket.ts`        | Lets sessions message each other and your Claude Code sessions, as Claude Code does       | Linux or macOS                                                   |
| `claude-hooks.ts`          | Runs Claude Code's hooks, from settings files and plugins, at Pi's events                 | —                                                                |
| `ask-user-question.ts`     | Adds `AskUserQuestion`, Claude Code's multiple-choice questions                           | —                                                                |
| `subagents.ts`             | Adds the `Agent` tool: subagents in their own Pi process, with Pi's agent definitions     | —                                                                |
| `claude-agents.ts`         | Adds Claude Code's agent definitions, tool names, and model families to `Agent`           | `subagents.ts`                                                   |
| `btw.ts`                   | `/btw`: a side question about the session that stays out of the conversation              | —                                                                |
| `goal.ts`                  | `/goal`: keeps working until an evaluator model judges a condition met                    | —                                                                |
| `scheduled-tasks.ts`       | `/loop`, `/cron`, and the cron tools: prompts on a schedule within the session            | —                                                                |
| `diff.ts`                  | `/diff`: a panel beside the conversation with the changes and each turn's edits           | git                                                              |
| `claude-remote-control.ts` | `/remote-control`: drive the session from the Claude app and claude.ai/code               | A Claude model on the Claude Code login                          |
| `background-agents.ts`     | The agent panel below the prompt: ↓ to the agents, Enter opens one, Ctrl+B to background  | `subagents.ts`                                                   |
| `claude-stream-only.ts`    | Keeps Claude Code on streamed responses, so a stalled one cannot leave Pi waiting         | `pi-claude-subscription`                                         |
| `claude-sdk-update.ts`     | Installs a newer Claude Agent SDK, and with it Claude Code, as soon as there is one       | `pi-claude-subscription`, npm                                    |
| `network-resilience.ts`    | Claude Code's handling of dropped connections: stall notice, restart, network wait        | —                                                                |

Every extension is a single file that works on its own. Code that several of
them need — the [small model](#small-model) choice, the overlay frame,
Claude Code's tool names, the instances and tokens of `gitlab.json` and
`openproject.json` — is copied into each of them, with a note that names the
other copies. `web_search` comes from the npm package `pi-web-access`; see
[Web search](#web-search).

## Set up Pi

Follow the steps in order — together they are the complete setup: Pi itself,
the Claude subscription, all twenty-four extensions, and the browser connection.
Every step except the Chrome switch in step 4 is a
shell command, so an agent can carry them out as well.

What you need first:

- Claude Code, installed and logged in with your Claude subscription
  (`claude`, then `/login`)
- A clone of this repository — the commands below run from its root:

  ```bash
  git clone https://github.com/dandjo/pi.dev-extensions.git
  cd pi.dev-extensions
  ```

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
which Pi needs. `pi update` updates Pi later. Skip the Quickstart's "Choose a
model" step (`/login`) — step 2 below connects Pi to your Claude subscription
instead.

### 2. Run Claude on your subscription

```bash
pi install npm:pi-claude-subscription
```

The package runs Claude models through Claude Code's login, so requests count
against your subscription and never move to API billing. Make it the default
in `~/.pi/agent/settings.json`, next to the `packages` entry the install wrote:

```json
{
  "defaultProvider": "claude-sdk",
  "defaultModel": "claude-opus-5-5",
  "packages": ["npm:pi-claude-subscription"],
  "compaction": { "reserveTokens": 32768 }
}
```

`/model` in Pi switches to another `claude-sdk/…` model.

The `compaction` reserve makes Pi compact before Claude Code refuses the
request. With its own auto-compaction off, Claude Code blocks locally at the
context window minus 23k tokens, so at 977k for a 1M model, and answers
"Prompt is too long". Pi's default reserve of 16384 tokens would only start
compacting at 983,616. Pi does recover from the error by compacting and
retrying, but the turn fails first.

The package brings the Claude Agent SDK, and with it Claude Code, at the
version of its first install, and `pi update` does not move it.
`claude-sdk-update.ts` from step 3 keeps it current, so that Claude Code knows
the newest models; see [claude-sdk-update](#claude-sdk-update).

### 3. Install the extensions

Link all twenty-four from the clone, so that `git pull` updates them:

```bash
mkdir -p ~/.pi/agent/extensions
for f in "$PWD"/extensions/*.ts; do ln -sf "$f" ~/.pi/agent/extensions/; done
```

Or copy them, if the clone may move:

```bash
mkdir -p ~/.pi/agent/extensions
cp extensions/*.ts ~/.pi/agent/extensions/
```

Pi loads every `.ts` file in `~/.pi/agent/extensions/` at start. Each file
stands on its own, so you may also take only the ones you want. There is no
build step and no `npm install`: the extensions import only packages Pi
provides itself. A `lib` folder or link in `~/.pi/agent/extensions/` from an
earlier setup is no longer used and can go.

When a pull adds or renames an extension, repeat the link or copy step. A link
whose file is gone must go too, or Pi fails to load it, and a renamed copy
must be deleted by hand, or Pi loads it twice (`remote-control.ts` is now
`claude-remote-control.ts`):

```bash
for f in ~/.pi/agent/extensions/*.ts; do [ -e "$f" ] || rm "$f"; done
```

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

### 5. Check the result

Start Pi in a project, or run `/reload` in a running session:

- The footer shows the status line with your subscription limits.
- A tool call is one line, `Bash(…)`, with a few lines of its result below;
  Ctrl+O shows all of it.
- "Search the web for …" answers through `web_search`.
- "Read https://… and tell me …" answers through `web_fetch`.
- "Which statuses does OpenProject have?" answers through `openproject`.
- "Which GitLab merge requests are assigned to me?" answers through `gitlab`.
- A few seconds after the first prompt, the terminal title reads
  `π - <session title> - <directory>`.
- With Pi running in a second terminal, `/peers` lists that session, and
  "Send the other session a hello" shows up there as `› Message from @…`.
- `/hooks` lists the hooks from your Claude Code settings.
- "Ask me with AskUserQuestion whether I prefer tea or coffee" shows a
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

## Manage extensions

`pi config` enables or disables each extension individually. To try one for a
single run without installing it:

```bash
pi -e ./extensions/web-tools.ts
```

To remove an extension, delete its file or link from `~/.pi/agent/extensions/`
and `/reload`. For `claude-marketplaces.ts`, also delete `~/.pi/agent/claude-marketplaces/`.
`pi remove npm:pi-web-access@0.44.0` removes web search.
`pi mcp remove chrome-devtools` removes the browser connection.

## claude-marketplaces

Brings the plugins of Claude Code marketplaces — their skills, hooks, and
agents — into Pi and keeps them current.

- The marketplaces come from `~/.pi/agent/claude-marketplaces.json`: under
  `marketplaces`, a map from each marketplace's git URL to its settings, like
  `mcpServers` in Pi's `mcp.json` (there are no settings yet, so `{}`).
  Without the file the extension does nothing.

  ```json
  {
    "marketplaces": {
      "git@github.com:acme/claude-marketplace.git": {},
      "https://example.com/team/plugins.git": {}
    }
  }
  ```

- Each marketplace gets its own clone in
  `~/.pi/agent/claude-marketplaces/<name>/repo`, `<name>` taken from the URL,
  pulled in the background at every Pi start (not with `PI_OFFLINE` set). Git
  never asks for a password there: SSH runs in batch mode.
- When a pull changed a plugin (its files, or the plugin list in
  `.claude-plugin/marketplace.json`), Pi reloads by itself, so the new skills,
  hooks, and agents apply without a restart. Commits that change only other
  files update the clone without a reload. On the very first start the clone
  is created the same way, followed by the reload.
- The reload waits until Pi is at rest in the terminal: no response or
  compaction running, nothing queued, no prompt just submitted, and the empty
  prompt editor in focus. An open selector such as `/resume` or `/model`, a
  dialog, or a half-typed prompt is never interrupted. Until then
  `<marketplace> plugins updated <old> -> <new>; Pi reloads once it is idle.`
  tells that the previous version is still loaded. Outside the terminal (RPC
  mode) the notice asks for `/reload` instead.
- `/marketplace-update` pulls every marketplace and reloads at once.
- Builds a copy of every plugin listed in `.claude-plugin/marketplace.json`
  whose source is a folder of the marketplace, in
  `~/.pi/agent/claude-marketplaces/<name>/plugins`, and adapts it to Pi:
  - Skill names carry the plugin, since Pi has no plugin namespaces:
    `/my-plugin:guidelines` becomes `/skill:my-plugin-guidelines`. References
    between the skills of a marketplace are rewritten the same way.
  - `${CLAUDE_SKILL_DIR}` and `${CLAUDE_PLUGIN_ROOT}` are replaced with the
    absolute paths of the copy, because Pi does not substitute them.
- The plugins' `hooks/` and `scripts/` are mirrored as they are, and every
  mirrored plugin is linked into `~/.pi/agent/claude-plugins/<plugin>`, where
  [claude-hooks](#claude-hooks) and [claude-agents](#claude-agents) look for
  Claude Code plugins, so their hooks and agents work in Pi as in Claude
  Code. The links are made at every start and
  after every update. A plugin name two marketplaces share goes to the first.
  Links into a copy (this extension's, or an earlier one's) follow the copies;
  any other entry there is left alone.
- Subagent processes ([subagents](#subagents)) skip the pull.
- Pi warns at start about skill descriptions longer than 1,024 characters (the
  skill loads anyway).
- Never edit files under `~/.pi/agent/claude-marketplaces/` — the clones are
  reset to the remote and the copies are rebuilt.

## statusline

Replaces Pi's footer in the interactive terminal with the lines of
[claude-code-cli-status-line](https://github.com/dandjo/claude-code-cli-status-line),
the same status line for Claude Code: model with its thinking level,
working directory, git branch, context-window usage, tokens, session cost, and
elapsed time, for any provider. Below them come the rows other extensions add
— [claude-usage](#claude-usage) adds the subscription limits — and the
statuses that other extensions set appear as a last line.

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
session at a time asks, at most every two minutes, and the others read the
file, so a new session shows the limits right away. The access token is read
from Pi's own Anthropic login in `~/.pi/agent/auth.json`, otherwise from Claude
Code's `~/.claude/.credentials.json` (on macOS from the login keychain item
`Claude Code-credentials`, where Claude Code keeps it). It is never refreshed
here and never written to the cache.

Without any Claude login, neither Pi's OAuth login nor Claude Code's, there
are no rows and no requests: someone on another provider sees nothing of
this. With `PI_OFFLINE` set (Pi's `--offline`), the rows show what another
session fetched last, and this one fetches nothing. Reset times, dates, and
credit amounts follow `LC_TIME` and `LC_MONETARY` (or `LC_ALL`, else `LANG`),
as other programs on the machine do: `Di., 10.11., 13:28` and `$ 12,34` under
`de_AT`, `Tue, 11/10, 01:28 PM` and `$12.34` under `en_US`. Node's own default
reads `LANG` alone.

Claude Code renews its token only when it makes a request, so after hours
without a prompt neither token is valid. The extension then starts a short
Claude Code process that asks for its usage (no model request, nothing
persisted); Claude Code renews the token under its own lock before it sends
that request, and the limits come back with the next fetch. A renewal runs at
most every five minutes, shared with [Remote Control](#claude-remote-control);
after one that leaves no valid token the wait doubles, up to an hour.

Other extensions get the answer through Pi's event bus: `claude-usage:source`
carries a source with the latest answer and a refresh under the same
two-minute rule, and `claude-usage:changed` follows every new one.
`claude-remote-control.ts` hands the limits to the Claude app that way.

Without an answer from the last hour, a single `Limits` line takes the place
of the limit lines and says why. A warning ends in `· next try 23:52`, the
time of the next attempt.

| Shown as                    | Cause                                      |
| :-------------------------- | :----------------------------------------- |
| `loading…`                  | The first answer is on its way             |
| `⚠ rate limited (HTTP 429)` | The endpoint turned the request away       |
| `⚠ no valid OAuth token`    | No unexpired token in either file, and Claude Code could not renew its login: run `claude`, then `/login` |
| `⚠ HTTP 401`                | The endpoint rejected the token            |
| `⚠ endpoint unreachable`    | Offline, or no answer within 10 seconds    |

## compact-tools

Draws every tool call as a teaser, the way Claude Code does, instead of Pi's
tall boxed rows:

```
Bash(git status --short)
  ⎿  M src/index.ts
     M README.md
     … +4 lines (ctrl+o to expand)

Read(src/index.ts)
  ⎿  Read 212 lines

Update(src/index.ts)
  ⎿  Added 3 lines, removed 1 line
     …the diff, up to ten lines…
```

- The first line names the call: the tool and the argument that matters — the
  command, the path, the URL, the request — cut after two terminal lines.
  Pi's tools carry Claude Code's names: `Bash`, `Read`, `Update`, `Write`,
  `Search`, `List`; an MCP tool reads `server - tool (MCP)`, a subagent by
  its type.
- The row keeps the background of Pi's rows, which shows the state: pending
  while the tool runs, then success or error, in the theme's `toolPendingBg`,
  `toolSuccessBg`, and `toolErrorBg`. Only the blank lines of padding above
  and below are gone.
- Below it comes the result as a teaser. Where a summary says more than the
  output, it stands alone: `Read 212 lines`, `Wrote 40 lines`, `Found 14
  lines`, `Listed 22 paths`, and for a subagent `Done (15 tool uses · 40.2k
  tokens · 1m 3s)`. An edit shows its line counts and the first ten lines of
  the diff. Everything else shows its first three lines and how many more
  there are. A failed call shows its last three lines instead, in red, since
  that is where the error stands, and a running one its latest output.
- Ctrl+O, or in fullscreen mode a click on the row, expands all rows: the
  call with its full arguments, and the result drawn by the tool's own
  renderer — highlighted file content, the whole diff, a subagent's report.
- It covers every tool — Pi's own, those of other extensions, and MCP tools —
  through `pi.registerToolRenderer()`. What the model sees does not change,
  and the HTML export shows the same rows. Tools whose own result is a teaser
  already (`AskUserQuestion`, `CronCreate`) keep it.
- The constants at the top of the file set the amounts: `PREVIEW_LINES` (3),
  `DIFF_PREVIEW_LINES` (10, `0` for the summary alone), and `CALL_LINES` (2).
- Without the file, the rows are Pi's again; nothing is stored.

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
- Writes need no confirmation. The tool's guidelines tell the model to write
  only what you asked for, to upload only files you named for that, to send a
  PATCH with the `lockVersion` of a fresh GET, and to validate an unclear
  payload against the form endpoint first.
- Out of reach, because no API offers them: PDF, CSV, and XLS exports, a
  meeting's iCal file, and the text of a wiki page (the API gives a wiki page's
  title and attachments only).

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
  registered. The forms of earlier versions, a list of `{"url", "token"}` and a
  single `{"url", "tokenEnv"}`, are still read.

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
  `[redacted]`.
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
- File contents (`…/raw`) and GraphQL answers come as they are. A job log
  (`…/jobs/{id}/trace`) comes without its colour codes, and when it is cut,
  it keeps its end, where the failure is.
- Output over 50 KB is cut and the full response saved to a temp file. Binary
  content, such as artifacts and archives, is saved to a temp file (mode 600)
  up to 100 MB.
- GraphQL is there for what REST lacks: an issue's iteration, for one, can
  only be set through `issueSetIteration`. A GraphQL answer with `errors`
  counts as failed.
- Requests go through `node:https`, not `fetch`: `fetch` sends
  `Sec-Fetch-Mode: cors`, and GitLab answers that with 406 on downloads such
  as repository archives. They use the proxy Pi uses for its own requests:
  Pi's `httpProxy` setting, applied as `HTTPS_PROXY` and `HTTP_PROXY`, or
  those variables themselves, with `NO_PROXY`. HTTPS goes through a `CONNECT`
  tunnel, and a user in the proxy URL is sent as `Proxy-Authorization`.
- Writes need no confirmation. The tool's guidelines tell the model to write
  only what you asked for and to read a single issue or merge request before
  changing its description.
- Git itself — clone, fetch, push — stays with `git`.

## clipboard

Adds the `clipboard` tool, with which the model reads and writes the system
clipboard on Linux and macOS: "look at the screenshot I copied", "copy the
command for me".

- `read` returns what the clipboard holds: text, an image, and on macOS the
  paths of files copied in Finder. An image comes as PNG, JPEG, WebP, or GIF
  (other formats are converted to PNG) and is scaled down as Pi's
  `images.autoResize` says, as with the `read` tool. `format` `text` or
  `image` asks for one of them only. Text beyond 50 KB or 2,000 lines is cut,
  the full text saved to a private temp file that goes when the session ends.
- `write` puts text on the clipboard with Pi's own copy routine, the one
  behind `/copy`: `wl-copy`, `xclip`, or `xsel` on Linux, the native helper or
  `pbcopy` on macOS, and over SSH OSC 52 to the terminal of your own machine.
  Writing never asks.
- Reading asks first: what the model reads goes to its provider, a password
  just copied from a password manager as much as anything else. The question
  names what the clipboard holds — text with its length, an image with its
  format and size — never the content. `{"confirmRead": false}` in
  `~/.pi/agent/clipboard.json` reads without asking. Without a UI (`pi -p`,
  subagents), reading is refused unless that is set.
- Linux reads through `wl-paste` on Wayland, else `xclip` on X11 (XWayland
  included), else Pi's native X11 helper with `xsel` for text; `wl-clipboard`
  or `xclip` covers everything. macOS needs nothing: Pi's native helper reads
  text, images, and files, and `pbpaste` stands in for text. Over SSH, the
  clipboard of the machine in front of you cannot be read; writing reaches it
  through OSC 52.
- For yourself, Pi already has `/copy` and `Ctrl+X` (copy the last answer)
  and `Ctrl+V` (paste text or an image into the editor).

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
- `/memory` shows the providers with the one in use and the index;
  `/memory edit` opens the index in Pi's editor.
- At start, a notice names the memory in use. Subagents get no memory, as in
  Claude Code.
- `memory.ts` replaces `claude-memory.ts`, which only read Claude Code's
  memory: delete a link or copy of `claude-memory.ts` in
  `~/.pi/agent/extensions/` (Pi reports a broken link as a load error) and
  link or copy `memory.ts` instead.

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

## session-socket

Lets the Pi sessions on your machine list and message each other, and message
your Claude Code sessions, the way Claude Code's
[cross-session messaging](https://code.claude.com/docs/en/cross-session-messaging)
works: with its wire protocol, its wording towards the model, and its safety
rules. "Tell the session in ~/projects/api that the migration is done" sends a
summary — not the conversation or its files.

- The model gets `ListAgents` and `SendMessage`, named and shaped like Claude
  Code's. `ListAgents` shows this session's own name and every other live
  session with its kind (Pi or Claude Code), idle or busy, working directory,
  and age. `SendMessage` takes the name as the address — `name [ref]` when two
  sessions share it — or, to answer a message, its `from` address. With
  `notify_when_idle`, a Pi session sends one `[Cross-session idle notice]` when
  it next goes idle or exits; the subscription expires after 12 hours.
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
  started — the `claude-sdk` provider's — are not listed. Tested against Claude
  Code 2.1.308; its protocol is not a public interface and can change with any
  Claude Code release.
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

## claude-hooks

Runs the hooks Claude Code would run, at the matching Pi events, with Claude
Code's [hook protocol](https://code.claude.com/docs/en/hooks): the event as
JSON on stdin, exit code 2 blocks, one JSON object on stdout decides.

- Sources: `~/.claude/settings.json`; the project's `.claude/settings.json`
  and `.claude/settings.local.json` once Pi trusts the project; and
  `hooks/hooks.json` of every Claude Code plugin in
  `~/.pi/agent/claude-plugins/<plugin>/` (a directory or a link to one;
  [claude-marketplaces](#claude-marketplaces) links its plugins there) and of
  every plugin Claude Code installed for you and enabled in
  `~/.claude/settings.json` (`enabledPlugins`; a plugin of the same name in
  `claude-plugins` replaces it), with
  `CLAUDE_PLUGIN_ROOT` set to the plugin and `CLAUDE_PLUGIN_DATA` to
  `~/.pi/agent/plugin-data/<plugin>`. `disableAllHooks: true` in a settings
  file turns them all off. The files are read again before every prompt.
- Events: `SessionStart` (at start, resume, `/new`, fork, reload, and after
  compaction; its output goes into the system prompt), `UserPromptSubmit`,
  `PreToolUse` (`deny` and exit 2 block the call, `ask` asks you,
  `updatedInput` rewrites it), `PostToolUse` and `PostToolUseFailure`
  (feedback is appended to the tool result, `updatedToolOutput` replaces it),
  `Stop` (continues the run, at most eight times in a row), `PreCompact`,
  `PostCompact`, `SessionEnd`, `Notification` (`idle_prompt` after 60 seconds
  idle), and inside subagents `SubagentStart` and `SubagentStop`. Other events
  never fire in Pi.
- Handler types `command` and `http`, with `matcher`, `if`, `timeout`,
  `async`, `asyncRewake`, and `onFailure`. `prompt`, `agent`, and `mcp_tool`
  hooks are skipped. A command runs in `bash`, or with `"shell": "powershell"`
  in `pwsh`; on Windows in the shells Pi itself uses there (Git Bash, and
  PowerShell 7 or Windows PowerShell), not in WSL.
- Tools reach hooks under Claude Code's names and input fields: `bash` as
  `Bash` with `command`; `read`, `write`, and `edit` as `Read`, `Write`, and
  `Edit` with an absolute `file_path` (an edit also with `old_string`,
  `new_string`, and `edits[]`); `grep` as `Grep`; `find` as `Glob`. MCP tools
  keep their `mcp__…` names.
- Skill references in hook output get Pi's names: `my-plugin:my-skill`
  becomes `my-plugin-my-skill`.
- Hooks run as your user, with your environment, like every extension.
  `/hooks` lists what is configured and what Pi skips.

## ask-user-question

`AskUserQuestion`, named and shaped like Claude Code's tool, so skills that ask
through it, such as setup wizards, work unchanged.

- One to four questions per call, each with a short header, two to four
  options, and optionally several answers; `Other` takes an answer in your own
  words.
- Several questions get a tab each and a Submit tab. Up/Down or the digits
  pick, Space toggles in a multi-select, Enter confirms, Tab/Left/Right switch
  questions, Esc dismisses.
- The highlighted option has the selection background, as in Claude Code.
- In fullscreen mode (`tuiMode`) the mouse works as well: the highlight follows
  the pointer, a tab under the pointer gets a lighter background than the open
  one, a click on an option picks it as Enter does (toggles it in a
  multi-select), a click on a tab opens it, a click on the submit line of the
  Submit tab submits, and the wheel moves the highlight. In the regular mode
  the terminal keeps the mouse. Under tmux, zellij, or screen Pi asks the
  terminal only for button motion, so there the highlight does not follow a
  pointer that merely moves.
- RPC clients get one select dialog per question. In `pi -p` and JSON mode the
  call fails with a note to decide alone. Subagents do not get the tool.
- With Remote Control active the questions can also be answered in the Claude
  app (see claude-remote-control). The first answer wins, from either place,
  and closes the other. Interrupting the run withdraws the questions.

## subagents

The `Agent` tool, after [Claude Code's subagents](https://code.claude.com/docs/en/sub-agents):
a subagent is a separate Pi process with its own context window, and only its
final report comes back.

- Agent types: the built-ins `general-purpose`, `Explore`, and `Plan` (the
  last two without `edit` and `write`), and definitions in Claude Code's format
  — Markdown with `name`, `description`, `tools`, `disallowedTools`, `model`,
  `effort`, `skills`, `omitClaudeMd`, `background` — from
  `~/.pi/agent/agents/` and the trusted project's `.pi/agents/`.
  [claude-agents](#claude-agents) adds Claude Code's directories and
  plugins.
- A subagent gets the parent's active tools, narrowed by its definition, whose
  `tools` and `disallowedTools` name Pi tools (`read`, `bash`, …). It never
  gets `AskUserQuestion`, the cron tools, `ListAgents`, or `SendMessage`, and
  subagents nest at most three levels deep. MCP servers start in it only when
  its tools name an MCP tool. Hooks run inside it too, with `agent_id` and
  `agent_type` in every event.
- Model: the call's `model` (a full model id), else the definition's, else the
  current one. [claude-agents](#claude-agents) adds the families `sonnet`,
  `opus`, `haiku`, and `fable`, and a default model.
- Several `Agent` calls in one response run in parallel.
  `run_in_background: true` returns at once; the report arrives later as a
  message that starts a turn, and the footer counts the running agents. A
  running foreground subagent can be moved to the background (Ctrl+B in
  [background-agents](#background-agents)); its `Agent` call then returns at
  once in the same way. `resume` with an agent ID continues that subagent
  with its history.
- Subagent sessions are stored in `~/.pi/agent/subagents/<session id>/` and
  deleted after 30 days. `/agents` lists the agent types and this session's
  subagents; `/agents stop <id>` stops a background one.
- A report reaches the model marked as the subagent's own words, so
  instructions in it carry no authority.
- The running and recently finished subagents are published on the event bus
  (`subagents:state`), where [background-agents](#background-agents) reads
  them; `subagents:stop` with an agent ID stops one, and
  `subagents:background` with an agent ID moves a running foreground one to
  the background.
- Other extensions extend the `Agent` tool through the event bus: they emit
  `subagents:provider` with a `SubagentsProvider` — agent directories, a
  translation of tool names, model families, a default model, limits — at load
  and again on every `subagents:provider-request`, so the load order does not
  matter.

## claude-agents

Brings Claude Code's agent definitions and settings to the `Agent` tool of
[subagents](#subagents), after
[Claude Code's subagents](https://code.claude.com/docs/en/sub-agents).
Without `subagents.ts` it does nothing.

- Definitions from `~/.claude/agents/` (`$CLAUDE_CONFIG_DIR/agents`), above
  `~/.pi/agent/agents/`; from the trusted project's `.claude/agents/`, at every
  level up to the repository root, below that level's `.pi/agents/`; and from
  `agents/` of the plugins in `~/.pi/agent/claude-plugins/` and of the plugins Claude Code installed for you and enabled, as
  `<plugin>:<name>`, below every user and project agent.
- Tool entries in Claude Code's names (`Read`, `Bash`, `Glob`, …) and
  permission rules (`Bash(git *)`) name the matching Pi tools, in every
  definition, those in `.pi/agents/` included.
- `sonnet`, `opus`, `haiku`, and `fable` as a model resolve to the newest
  model of that family on the current provider; a family the current model
  belongs to keeps the current model.
- `CLAUDE_CODE_SUBAGENT_MODEL` is the model when neither the call nor the
  definition names one. `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` (default 3) and
  `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS` (default 20) set how deep subagents
  nest and how many run at once.

## background-agents

The agent panel below the prompt, after Claude Code's: while subagents run, in
the background or in the foreground, the panel lists them, ↓ from the prompt
moves into it, Enter shows an agent's live transcript in place of the
conversation, and Ctrl+B moves a foreground agent to the background.

- The panel appears under the editor as soon as a subagent runs: a
  `main` row, then one row per agent with its type, description, elapsed time,
  and tokens. At most five rows are visible; the window follows the selection,
  with `↑ N more` and `↓ N more` for the rest. Finished agents stay 30
  seconds — completed ones with a green mark, failed or stopped ones with a red
  one — then disappear. The footer reads `↓ to manage` while the panel exists.
- ↓ on the last line of the prompt (not while browsing history or with the
  autocomplete open) selects the `main` row; the footer then says what the
  keys do. ↑/↓ move, ↑ from `main` returns to the prompt, Enter opens the
  selected agent (on `main` it shows the conversation again and returns to
  the prompt), `x` stops a running
  agent or clears a finished one, Esc returns to the prompt, and any typed
  character goes into the prompt. `/tasks` offers the same list as a dialog.
- An open agent replaces the conversation above the prompt, as in Claude
  Code; the prompt and the panel stay where they are. The view shows the
  agent's type, task, state, tokens, and model, then its transcript as it is
  written: the task, the assistant's text, each tool call as one line, and
  the first lines of each result. It follows the end while the agent works
  and scrolls like the conversation (wheel, PgUp PgDn), beside the
  [diff](#diff) panel too. The viewed agent is marked `●` in the panel and
  `main` becomes `◯`; ↓ Enter (`main`) shows the conversation again, at the
  scroll position it had.
- Subagents cannot be messaged — Pi runs them as one-shot processes — so the
  prompt stays with `main`: sending a prompt or a `!` command while an agent
  is shown brings the conversation back, with the new message in it. The
  agent's report arrives in the conversation when it finishes.
- Foreground subagents (without `run_in_background`) are listed too; their
  tool call still shows their progress in the conversation. Ctrl+B moves them
  to the background, as in Claude Code: the one selected in the panel, or else
  every foreground agent. Its `Agent` call returns at once, the conversation
  goes on, and the report arrives as a message when the agent finishes. While
  one runs, the footer adds `ctrl+b to run in background`; without a
  foreground agent, Ctrl+B stays the editor's cursor left.
- Scheduled tasks ([scheduled-tasks](#scheduled-tasks)) are listed below the
  agents, marked `↻`, with their prompt, schedule, and next run, and the panel
  also appears while only tasks are scheduled. Enter opens the task in the
  task manager, `x` deletes it.
- In fullscreen mode a click on a row opens it, a click on `main` shows the
  conversation and returns to the prompt, and a click on `↓ to manage` in the
  footer moves into the panel.
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
  exits.
- Every question sends the conversation to the session's provider again,
  without reusing its prompt cache, so it costs input tokens in proportion to
  the session's length.
- Side questions from the Claude app arrive through
  [claude-remote-control](#claude-remote-control) (`btw:ask` on the event bus)
  and are answered the same way, with the app's own earlier side questions;
  they do not join the terminal's thread.

## goal

`/goal <condition>` keeps the agent working, turn after turn, until a separate
evaluator judges the condition met — Claude Code's
[`/goal`](https://code.claude.com/docs/en/goal).

- Setting a goal starts a turn with the condition as the instruction. `/goal`
  alone shows the status: condition, running time, evaluated turns, tokens,
  and the last reason. `/goal clear` (also `stop`, `off`, `reset`, `none`,
  `cancel`) removes it.
- After every run that ends normally, the [small model](#small-model) reads
  the condition and the conversation and answers met, not met, or impossible,
  with a reason. Not met continues the run with the reason as guidance; met
  and impossible clear the goal. Every verdict shows in the transcript.
- The evaluator runs no commands, so a condition should name a check whose
  output appears in the conversation: "all tests in test/auth pass (`npm test`
  exits 0)".
- The loop pauses, with the goal still set, after three evaluated turns
  without a tool call, after an error, or when you interrupt it; your next
  message resumes it. While background subagents run, evaluation waits for
  their reports.
- The goal is stored in the session and restored on resume. The footer shows
  `◎ /goal active` and how long it has run. `pi -p "/goal …"` runs the loop to
  the end.

## scheduled-tasks

Claude Code's
[session-scoped scheduled tasks](https://code.claude.com/docs/en/scheduled-tasks):
`/loop`, `/cron`, and the tools `CronCreate`, `CronList`, `CronDelete`, and
`ScheduleWakeup`.

- `/loop 5m <prompt>` (or `<prompt> every 2 hours`; units `s`, `m`, `h`,
  `d`) runs the prompt now and then on that schedule. An interval no cron step
  fits, such as `7m`, is rounded to the nearest one that does, with a notice.
  `/cron delete <id>` stops it.
- `/loop <prompt>` without an interval paces itself: after each iteration the
  model schedules the next one in one to 60 minutes with `ScheduleWakeup`, or
  ends the loop. An iteration that does neither gets one fallback 20 minutes
  later. Esc on an empty editor while the loop waits, or `/loop stop`, cancels
  it.
- `/loop` alone runs `.claude/loop.md` (also `.pi/loop.md`,
  `~/.claude/loop.md`, `~/.pi/agent/loop.md`), read fresh at every iteration,
  otherwise a maintenance prompt: continue unfinished work, tend to the
  branch's merge request, then clean up.
- "Remind me at 3 pm to …" or "check the pipeline every 10 minutes" makes the
  model schedule a task with `CronCreate` — a standard 5-field cron expression
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
  most 50. They are stored in the session and restored on resume, except
  self-paced loops. `CLAUDE_CODE_DISABLE_CRON=1` turns all of it off.

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
  link and the QR code; `d` there disconnects, the local session goes on.
  `pi --remote-control` connects at start, as does
  `"remoteControlAtStartup": true` in `~/.claude/settings.json` once Remote
  Control was enabled here.
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
- Questions: an `AskUserQuestion` dialog opens in the app as well, as Claude
  Code's question card, and can be answered there or in the terminal. The app
  takes an answer only for a pending permission request, so the questions go
  out as one (`can_use_tool`), and the session shows as waiting for input while
  they are open. An answer from the app closes the terminal dialog. An answer
  from the terminal goes to the app and withdraws the card there, as do Esc and
  an interrupted run. Declining in the app with a note passes that note to the
  model.
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
  `pi-claude-subscription` installs: under `~/.pi/agent/npm`, in a project's
  `.pi/npm`, or in npm's global root, wherever Pi put that package. It creates the
  session, mints a four-hour worker credential, and runs the event stream,
  heartbeats, and reconnects; the extension renews the credential five minutes
  before it expires and reconnects on its own after an outage. If another
  process takes the session over, or the server rejects it, the connection
  ends with a notice.
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
  out, and `/rc` warns about it:
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
- Login: the claude.ai OAuth token of Claude Code (`~/.claude/.credentials.json`,
  on macOS the login keychain; it carries the `user:sessions:claude_code` scope), read fresh for every
  request and never refreshed here — Claude Code refreshes it while the
  `claude-sdk` provider runs it. That is why Remote Control needs a Claude
  model: without one, `/rc` declines, and switching to another model
  disconnects. Pi's own Anthropic login is the fallback. Remote Control needs a
  Pro, Max, Team, or Enterprise plan; on Team and Enterprise an owner must
  allow it in the Claude Code admin settings.
- Overnight: Claude Code renews its token only when it makes a request, and the
  provider ends idle Claude Code processes, so after about eight hours without
  a prompt the token has run out and the four-hourly renewal of the connection
  fails. The extension then starts a short Claude Code process that asks for
  its usage (no model request, nothing persisted); Claude Code renews the token
  under its own lock before it sends that request, and the connection is
  renewed with it — at most every five minutes, and after a renewal that
  fails the wait doubles, up to an hour. The status line
  ([claude-usage](#claude-usage)) shares the renewal. The session log notes such a
  renewal (`Remote Control had Claude Code renew the claude.ai login …`), a
  renewal that keeps failing for five minutes with its reason, and the
  reconnect after it.
- While connected, the conversation is stored on Anthropic's servers under the
  claude.ai data policy; execution and files stay on your machine, and the
  session only makes outbound HTTPS requests. Disconnecting and quitting
  archive the remote session.
- `pi-claude-subscription` 0.2.4 ships SDK 0.3.308, which reports itself as
  Claude Code 2.1.308. The bridge API is not a public interface and can change
  with any SDK release.

## claude-stream-only

Keeps a stalled response from hanging the run. When a streamed response
stalls, Claude Code repeats the request without streaming and gets the answer
as one finished message. `pi-claude-subscription` builds Pi's response from
the stream alone, so that answer never reaches Pi: a tool call in it waits for
Pi while Pi waits for the answer, until the run is aborted.

- Sets `CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK=1` in Pi's own environment,
  which the provider hands to every Claude Code process it starts. A stalled
  stream then ends as a retried stream or as an error, and both reach Pi.
- Applies to Pi alone, not to the shell. A value set before Pi starts is
  kept.
- Claude Code processes started before the extension was loaded keep their
  environment; start Pi anew to apply it.

## claude-sdk-update

Keeps the Claude Agent SDK of `pi-claude-subscription` current. The SDK brings
Claude Code along, and Claude Code takes each model's context window from a
list built into it: a model newer than the bundled Claude Code counts as 200k,
so Claude Code refuses a longer session with "Prompt is too long" before any
request, although the model takes 1M. `pi update` does not move the SDK,
since npm keeps a dependency at the version of `package-lock.json`.

- At every start in the terminal, Pi compares the SDK in `~/.pi/agent/npm`
  with the npm registry in the background. Print, JSON, and RPC mode,
  subagents, and `PI_OFFLINE` skip the check.
- A newer version within the range the installed packages allow
  (`pi-claude-subscription` asks for `^0.3.289`) is installed right away, with
  `npm update @anthropic-ai/claude-agent-sdk --legacy-peer-deps` as Pi
  installs its packages: without the flag, npm would install Pi itself as a
  peer dependency. A notice names the old and the new SDK and Claude Code
  version, and Pi processes started from then on use them. Running sessions
  keep the SDK they loaded; start them anew.
- A newer version outside the range is reported once per version: it needs a
  new `pi-claude-subscription` first (`pi update npm:pi-claude-subscription`).
- `/claude-sdk-update` checks and installs at once and reports the state,
  also when nothing is due.
- Pi processes starting together update one at a time, through a lock file
  in `~/.pi/agent/npm`. While npm replaces the package, Claude Code is missing
  for a few seconds; a request that starts Claude Code just then fails and
  can be repeated.
- Works with npm, Pi's default. With an `npmCommand` setting for pnpm or Bun,
  the extension does nothing.

## network-resilience

Keeps a request alive through network trouble the way Claude Code does. Pi on
its own retries three times within 14 seconds and shows nothing while a
request hangs. Through `pi-claude-subscription`, Claude Code's own retries stay
invisible too, because the provider drops their messages: Pi says "Working…"
for as long as Claude Code retries, twenty minutes and more when its connects
time out.

- After 20 seconds without stream data, the working message counts the wait
  and says whether the API host answers, as Claude Code's "Waiting for API
  response · check your network" does. The check is a TCP connect to the
  model's API host (`api.anthropic.com` for `claude-sdk`), through
  `HTTPS_PROXY` when one is set. A provider without an http(s) base URL other
  than `claude-sdk` is not checked unless `probeHost` names a host for it.
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
  When the last response is more than 5 minutes old, the prompt cache is cold
  and the API reads the whole context first, which took Claude Opus up to 42
  seconds: then the restart waits 60 seconds.
- A request silent for 5 minutes while the host answers is restarted too. At
  most three restarts follow each other without a response in between.
- Before every request that follows a connection error, Pi's own retries
  included, the host is checked. While it does not answer, Pi waits and checks
  every 3 seconds instead of spending its retries, for up to 30 minutes per
  outage; Esc interrupts the wait.
- When Pi gives up on a transient error, the run continues with Claude Code's
  backoff (4, 8, 16, then 32 seconds) until ten requests in a row have failed,
  with the attempt and the countdown in the working message. Usage limits,
  login, request, and context errors are never retried.
- Settings, all optional, go into `~/.pi/agent/network-resilience.json`:
  `noticeSeconds` (20), `graceSeconds` (10), `stallSeconds` (300; 0 turns
  the silence restart off), `maxRestarts` (3), `maxAttempts` (10),
  `offlineWaitMinutes` (30; 0 turns the waiting off), and `probeHost`
  (`host:port` to check instead of the API host).
- When the API delivers data while the check fails, the check does not
  reflect your network, behind a proxy Pi does not know of, for example.
  Checking then stops until Pi restarts, and restarts after a disruption
  follow the 10 seconds alone. Set `probeHost` to a host that answers.

## Small model

`session-title.ts`, `web-tools.ts`, and `goal.ts` carry the same code that
picks the model for side tasks — session titles, `web_fetch` answers, and the
`/goal` evaluator — for whatever provider and model are in use:

- Among the models of the current model's provider that have working
  credentials and read text, it takes the one with the lowest list price (input
  plus output per million tokens), if that is cheaper than the current model.
  Otherwise it keeps the current model. With `claude-sdk` or `anthropic` that is
  Claude Haiku 5.5, with `openai` currently `gpt-5-nano`.
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
- Side requests run one at a time, across all extensions, and give up after two
  minutes. `/btw` waits its turn the same way, on the session's own model. `claude-sdk` keeps at most three Claude Code processes and closes
  the least recently used one outside a call, which can be the conversation's
  own process while it waits for tool results: four parallel `web_fetch` calls
  then reached the model as "Tool call interrupted".
- Through `claude-sdk`, a side request carries its own short system prompt
  instead of Claude Code's. Tested with extra usage switched off, Anthropic
  counted it against the subscription; a request counted as third-party
  traffic would have been rejected instead.

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
    tools added mid-session can cost a prompt-cache miss, and with `claude-sdk`
    a new Claude Code process.
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

## License

[MIT](LICENSE).

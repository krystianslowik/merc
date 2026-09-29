<p align="center">
  <img src="docs/banner.png" alt="merc: Claude dispatches a squad of agents running other models" width="100%">
</p>

<h1 align="center">merc</h1>

<p align="center">
  <b>Hire coding agents on any model, right from Claude Code.</b><br>
  GPT, Gemini, DeepSeek, Kimi or local models, anything <a href="https://opencode.ai">opencode</a> can run, as a native subagent.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Claude_Code-plugin-d97757" alt="Claude Code plugin">
  <img src="https://img.shields.io/badge/runs_on-opencode-24292f" alt="Runs on opencode">
  <img src="https://img.shields.io/badge/node-%E2%89%A523.6-339933?logo=nodedotjs&logoColor=white" alt="Node 23.6 or newer">
</p>

<p align="center">
  <a href="#install"><b>Install</b></a>
  &nbsp;&middot;&nbsp;
  <a href="#usage">Usage</a>
  &nbsp;&middot;&nbsp;
  <a href="#how-it-works">How it works</a>
  &nbsp;&middot;&nbsp;
  <a href="#configuration">Configuration</a>
</p>

Claude Code only runs Claude. merc lets it hand a job to an opencode agent on another model, for a second opinion, a cheap bulk pass, or a review by something that thinks differently. The agent shows up in the agent list, streams its work in Claude Code's own style, keeps its session across follow-ups, and stops on Esc.

```
> use merc:luna to fix the failing test in math.js

● merc:luna(Fix the failing test in math.js)
  ⎿  ● Read(math.js)
       ⎿  Read 1 line
     ● Update(math.js)
       ⎿  Updated with 1 addition and 1 removal
          -export const add = (a, b) => a - b;
          +export const add = (a, b) => a + b;
     ● Bash(node --test)
       ⎿  tests 4 · pass 4 · fail 0

     Fixed: `add` subtracted instead of adding. All 4 tests pass.

     Done (3 tool uses · 42.1k tokens · $0.0031 · 18.4s)
     opencode · openrouter/openai/gpt-6-luna (high) · session ses_f20560825ffe...
```

## Features

- `merc:opencode` (any model) and `merc:luna` are real subagents: foreground or background, and `SendMessage` follow-ups resume the same opencode session.
- Steps stream in as they finish. A status line shows what every running merc is doing, and `merc watch` follows a session live in another pane.
- Model and reasoning effort are per task. An effort level the model doesn't have is rejected up front, instead of opencode silently ignoring it.
- Every result ends with tool uses, tokens, time and cost (sub-agents included) and the model that actually ran.
- Esc, a timeout or a stopped agent kills the whole opencode process group, so nothing keeps editing your files after you've stopped it.

## Install

Needs Node 23.6+ (it runs the TypeScript directly) and [opencode](https://opencode.ai) with a provider logged in (`opencode auth login`).

```sh
git clone https://github.com/krystianslowik/merc.git && cd merc
yarn install
claude plugin marketplace add ./
claude plugin install merc@ex-subagent
```

Restart Claude Code afterwards; a plugin reload doesn't restart MCP servers. Allow the tools in `.claude/settings.json` so background mercs don't sit on a permission prompt:

```json
{
  "permissions": {
    "allow": ["mcp__plugin_merc_opencode__start", "mcp__plugin_merc_opencode__wait", "mcp__plugin_merc_opencode__cancel"]
  }
}
```

## Usage

Ask Claude in plain words, or put header lines at the top of the task:

```
use merc:opencode for this:
model: openrouter/openai/gpt-6-astra
variant: high
Review src/ for race conditions. Do not modify files.
```

- `model:` any `provider/model` from `opencode models`. Defaults to `OPENCODE_BRIDGE_MODEL`, then your opencode default.
- `variant:` reasoning effort. Levels differ per model (`opencode models <provider> --verbose`): GPT-6 Luna has `none` to `max`, DeepSeek V4 Flash only `high` and `xhigh`.

`merc:luna` is a fixed route to GPT-6 Luna. For your own, copy `agents/luna.md` and change the model line.

From a terminal:

```sh
node src/cli.ts -m openrouter/openai/gpt-6-luna -e high "fix the failing test"
node src/cli.ts watch                 # follow the latest session here, live
node src/cli.ts watch ses_... --all   # replay a whole session
```

`merc status` prints one line per running merc (model, current step, tools, cost). To add it under your existing status line:

```json
{
  "statusLine": {
    "type": "command",
    "command": "node /path/to/merc/src/cli.ts status --wrap '<your existing status line command>'",
    "refreshInterval": 2
  }
}
```

## How it works

<img src="docs/architecture.svg" alt="Architecture: Claude Code, merc relay agent, merc MCP server, opencode, model providers" width="100%">

Claude Code only shows a tool result when the call returns, so one long call can't stream. merc splits a run into `start` and a loop of short `wait` calls. The relay agent, a thin Sonnet pass-through, keeps calling `wait`, and each call returns the steps finished since the last one. The MCP server runs `opencode run --format json` in its own process group and renders the event stream as Claude Code transcript lines. `merc watch` and the status line read opencode's SQLite store directly.

| Piece | Role |
| --- | --- |
| `agents/*.md` | Relay subagents: loop `start` + `wait`, return the final answer verbatim |
| `src/mcp.ts` | MCP server: `task` (blocking), `start`, `wait`, `cancel` |
| `src/runs.ts` | Background runs, polled in batches |
| `src/opencode.ts` | Runs opencode, parses events, owns the process lifecycle |
| `src/format.ts` | Transcript lines and the cost footer |
| `src/store.ts` | Reads opencode's store: live steps, real model, sub-agent cost |
| `src/variants.ts` | Checks reasoning effort against the model's variants |
| `src/cli.ts` | The `merc` CLI: run, `watch`, `status` |

## Configuration

| Env var | Effect |
| --- | --- |
| `OPENCODE_BRIDGE_MODEL` | Default `provider/model`. Unset: opencode's default |
| `OPENCODE_BRIDGE_VARIANT` | Default reasoning effort. Unset: the model's default |
| `OPENCODE_SERVER_URL` | Use a shared `opencode serve`, so you can watch the full TUI with `opencode attach <url>` |
| `OPENCODE_SERVER_PASSWORD` / `_USERNAME` | Basic auth for that server |
| `OPENCODE_BIN` | Path to the opencode binary |
| `OPENCODE_DB` | opencode's SQLite store (default `~/.local/share/opencode/opencode.db`) |

Runs time out after 30 minutes. A run nobody has polled for 10 minutes (its relay agent was stopped) is cancelled.

## Development

```sh
yarn typecheck
yarn test          # node:test with fake opencode binaries and mock servers, no API calls
```

Installed from a local folder, the plugin runs straight from it, so after editing `src/` a `/mcp` reconnect picks up the change.

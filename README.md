<p align="center">
  <img src="docs/banner.png" alt="merc: Claude dispatches a squad of agents running other models" width="100%">
</p>

<h1 align="center">merc</h1>

<p align="center">
  <b>Hire coding agents on any model, right from Claude Code.</b><br>
  GPT, Gemini, DeepSeek, Kimi, local models: anything <a href="https://opencode.ai">opencode</a> can run,
  shown as a native Claude Code subagent.
</p>

---

Claude Code only runs Claude. Sometimes you want a second opinion from GPT, a cheap bulk pass on a fast model, or a review by something that thinks differently. **merc** lets Claude hand a job to an opencode agent on any provider and keeps it feeling native: the agent shows up in the agent list, its work streams into the transcript in Claude Code's own style, follow-up messages continue the same session, and Esc actually stops it.

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

- **Native subagents.** `merc:opencode` (any model) and `merc:luna` appear in Claude Code's agent list, run in the foreground or background, and accept `SendMessage` follow-ups that resume the same opencode session.
- **Live progress.** Steps stream into the agent in batches as they complete, a status line shows what every running merc is doing, and `merc watch` follows a session step by step in another pane.
- **Any model, any effort.** Pick the model and reasoning effort per task. Invalid effort levels are caught before the run (opencode would silently ignore them).
- **Honest accounting.** Every result ends with tool uses, tokens, time and cost, including sub-agents the merc spawned itself, plus the model that actually ran.
- **Real cancellation.** Esc, a timeout or a stopped agent kills the whole opencode process group, and on a shared server aborts the turn too. Nothing keeps editing your files unseen.

## How it works

<p align="center">
  <img src="docs/architecture.svg" alt="Architecture: Claude Code, merc relay agent, merc MCP server, opencode, model providers" width="900">
</p>

Claude Code only renders a tool result when the call returns, so a single long call can't stream. merc splits a run into `start` plus a loop of short `wait` calls: the relay agent (a thin Sonnet pass-through) keeps calling `wait`, and each call returns the steps finished since the last one. The MCP server runs `opencode run --format json` in its own process group, parses the event stream and renders it in Claude Code's transcript style. For side channels, `merc watch` and the status line read opencode's local SQLite store directly.

| Piece | Role |
| --- | --- |
| `agents/*.md` | Relay subagents: loop `start` + `wait`, hand back the final answer verbatim |
| `src/mcp.ts` | MCP server: `task` (blocking), `start`, `wait`, `cancel` |
| `src/runs.ts` | Background runs, polled in batches |
| `src/opencode.ts` | Runs opencode, parses events, owns the process lifecycle |
| `src/format.ts` | Claude Code style transcript and cost footer |
| `src/store.ts` | Reads opencode's store: live steps, real model, sub-agent cost |
| `src/variants.ts` | Validates reasoning effort against the model's own variants |
| `src/cli.ts` | The `merc` CLI: run, `watch`, `status` |

## Install

Requires Node 23.6+ (runs the TypeScript directly, no build step) and [opencode](https://opencode.ai) with at least one provider logged in (`opencode auth login`).

```sh
git clone https://github.com/krystianslowik/merc.git && cd merc
yarn install
claude plugin marketplace add ./
claude plugin install merc@ex-subagent
```

Restart Claude Code afterwards (a plugin reload does not restart MCP servers). Allowing the tools up front keeps background mercs from waiting on a permission prompt, in `.claude/settings.json`:

```json
{
  "permissions": {
    "allow": ["mcp__plugin_merc_opencode__start", "mcp__plugin_merc_opencode__wait", "mcp__plugin_merc_opencode__cancel"]
  }
}
```

## Usage

Ask Claude in plain words, or be explicit with header lines at the top of the task:

```
use merc:opencode for this:
model: openrouter/openai/gpt-6-astra
variant: high
Review src/ for race conditions. Do not modify files.
```

- `model:` any `provider/model` from `opencode models`. Default: `OPENCODE_BRIDGE_MODEL`, else your opencode default.
- `variant:` reasoning effort. Levels are per model (`opencode models <provider> --verbose`); for example GPT-6 Luna has `none` to `max`, DeepSeek V4 Flash only `high` and `xhigh`.
- Follow-ups: send the same agent another message and it continues the opencode session with full context.

`merc:luna` is a fixed route to GPT-6 Luna. For your own fixed routes, copy `agents/luna.md` and change the model line.

### From a terminal

```sh
node src/cli.ts -m openrouter/openai/gpt-6-luna -e high "fix the failing test"
node src/cli.ts watch                 # follow the latest session in this directory, live
node src/cli.ts watch ses_... --all   # replay a whole session
```

### Status line

`merc status` prints one line per running merc: model, current step, tool count and cost. To keep your existing status line and add merc under it:

```json
{
  "statusLine": {
    "type": "command",
    "command": "node /path/to/merc/src/cli.ts status --wrap '<your existing status line command>'",
    "refreshInterval": 2
  }
}
```

## Configuration

| Env var | Effect |
| --- | --- |
| `OPENCODE_BRIDGE_MODEL` | Default `provider/model`. Unset: opencode's configured default |
| `OPENCODE_BRIDGE_VARIANT` | Default reasoning effort. Unset: the model's own default |
| `OPENCODE_SERVER_URL` | Run on a shared `opencode serve`, so you can watch the full TUI with `opencode attach <url>` |
| `OPENCODE_SERVER_PASSWORD` / `_USERNAME` | Basic auth for that server |
| `OPENCODE_BIN` | Path to the opencode binary |
| `OPENCODE_DB` | Path to opencode's SQLite store (default `~/.local/share/opencode/opencode.db`) |

Runs time out after 30 minutes. A run nobody polls for 10 minutes (its relay agent was stopped) is cancelled.

## Development

```sh
yarn typecheck
yarn test          # node:test, fake opencode binaries and mock servers; no API calls
```

Installed from a local directory, the plugin runs straight from this folder, so after editing `src/` a `/mcp` reconnect picks up the change.

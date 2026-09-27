#!/usr/bin/env node
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { formatEvent, formatFooter } from "./format.ts";
import { interrupt, runTask } from "./opencode.ts";
import { execSync } from "node:child_process";
import { activeSessions, follow, latestSession, turnStart } from "./store.ts";

const USAGE = `Usage: merc [options] <prompt...>   (or pipe the prompt on stdin)
       merc watch [session] [--all]   follow a running session live (default: latest in cwd)
       merc status [--wrap <cmd>]     one line per running session, for a Claude Code status line
       merc subagent-status           rows for Claude Code's subagent panel (plugin subagentStatusLine)

  -m, --model <provider/model>   default: $OPENCODE_BRIDGE_MODEL, else opencode's configured model
  -e, --variant <effort>         reasoning effort, e.g. low, high, max (default: $OPENCODE_BRIDGE_VARIANT)
  -a, --agent <name>             opencode agent to run as
  -s, --session <id>             continue an existing opencode session
  -C, --cwd <dir>                working directory (default: current)
      --attach <url>             run on a live \`opencode serve\` (default: $OPENCODE_SERVER_URL)
      --json                     print raw opencode events instead of the transcript`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    model: { type: "string", short: "m" },
    variant: { type: "string", short: "e" },
    agent: { type: "string", short: "a" },
    session: { type: "string", short: "s" },
    cwd: { type: "string", short: "C" },
    attach: { type: "string" },
    json: { type: "boolean" },
    all: { type: "boolean" },
    wrap: { type: "string" },
    help: { type: "boolean", short: "h" },
  },
});

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString();
}

if (values.help) {
  console.error(USAGE);
  process.exit(0);
}
const cwd = resolve(values.cwd ?? ".");

if (positionals[0] === "status" && positionals.length === 1) {
  // Status line mode: must be fast and never fail, or Claude Code shows nothing.
  const input = await readStdin().catch(() => "");
  if (values.wrap) {
    try {
      process.stdout.write(execSync(values.wrap, { input, encoding: "utf8", timeout: 5_000 }).replace(/\n+$/, "") + "\n");
    } catch {
      // Keep our line even if the wrapped status line fails.
    }
  }
  for (const s of activeSessions()) {
    const step = s.latest ? (formatEvent(s.latest, cwd) ?? "").split("\n")[0].replace(/^● /, "") : "starting";
    const shortStep = step.length > 60 ? `${step.slice(0, 59)}…` : step;
    console.log(`opencode · ${s.model ?? "?"} · ${shortStep} · ${s.tools} tool${s.tools === 1 ? "" : "s"} · $${s.cost.toFixed(3)}`);
  }
  // Piped stdout is async on macOS; flush before exiting.
  await new Promise((r) => process.stdout.write("", r));
  process.exit(0);
}

if (positionals[0] === "subagent-status" && positionals.length === 1) {
  // Subagent panel rows: for each running opencode relay agent, show what its opencode session is doing.
  const input = await readStdin().catch(() => "");
  try {
    const { tasks = [] } = JSON.parse(input || "{}") as { tasks?: { id: string; status?: string }[] };
    const relays = tasks.filter((t) => JSON.stringify(t).includes("opencode") && t.status !== "completed");
    // Relay agents and opencode sessions are not linked by id; pair them newest first.
    const sessions = activeSessions(60_000);
    relays.forEach((task, i) => {
      const s = sessions[i];
      if (!s) return;
      const step = s.latest ? (formatEvent(s.latest, cwd) ?? "").split("\n")[0].replace(/^● /, "") : "starting";
      const content = `${s.model ?? "opencode"} · ${step.length > 50 ? `${step.slice(0, 49)}…` : step} · ${s.tools} tool${s.tools === 1 ? "" : "s"} · $${s.cost.toFixed(3)}`;
      console.log(JSON.stringify({ id: task.id, content }));
    });
  } catch {
    // Default rows on any failure.
  }
  await new Promise((r) => process.stdout.write("", r));
  process.exit(0);
}

if (positionals[0] === "watch" && positionals.length <= 2) {
  const session = positionals[1] ?? latestSession(cwd);
  if (!session) {
    console.error(`No opencode session found for ${cwd}`);
    process.exit(1);
  }
  const controller = new AbortController();
  process.removeListener("SIGINT", interrupt);
  process.once("SIGINT", () => controller.abort());
  console.log(`Watching ${session} (Ctrl-C to stop)\n`);
  // Replay the current turn first, so joining mid-run shows what already happened.
  await follow(session, (event) => {
    const block = formatEvent(event, cwd);
    if (block) console.log(`${block}\n`);
  }, { signal: controller.signal, since: values.all ? 0 : turnStart(session) });
  process.exit(0);
}

const prompt = positionals.join(" ").trim() || (await readStdin()).trim();
if (!prompt) {
  console.error(USAGE);
  process.exit(2);
}

const controller = new AbortController();
// The first interrupt prints a cancellation result; a second exits the bridge.
process.removeListener("SIGINT", interrupt);
process.once("SIGINT", () => {
  process.on("SIGINT", interrupt);
  controller.abort();
});
// Stream each block as it happens so a watching terminal sees live progress.
const result = await runTask({
  prompt,
  cwd,
  model: values.model,
  variant: values.variant,
  agent: values.agent,
  session: values.session,
  attach: values.attach ?? process.env.OPENCODE_SERVER_URL,
  signal: controller.signal,
  onEvent: (event) => {
    if (values.json) return console.log(JSON.stringify(event));
    const block = formatEvent(event, cwd);
    if (block) console.log(`${block}\n`);
  },
});

if (values.json) {
  if (result.error) console.error(result.error);
} else {
  if (result.error && !result.events.some((e) => e.type === "error")) console.log(`● Error: ${result.error}\n`);
  console.log(formatFooter(result));
}
// exitCode instead of exit(): piped stdout is async on macOS and would get cut off.
process.exitCode = result.error ? 1 : 0;

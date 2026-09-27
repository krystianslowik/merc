import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { formatTranscript, stripCwd, summarize, toolResult } from "../src/format.ts";
import { buildArgs, runTask, type OpencodeEvent } from "../src/opencode.ts";

const events = readFileSync(new URL("./fixtures/fix-add.jsonl", import.meta.url), "utf8")
  .trim()
  .split("\n")
  .map((l) => JSON.parse(l) as OpencodeEvent);

test("renders a recorded run as a Claude Code style transcript", () => {
  const out = formatTranscript(
    { events, sessionID: events[0].sessionID, model: "openrouter/deepseek/deepseek-v4-flash", durationMs: 11700 },
    "/work",
  );
  assert.match(out, /^● Read\(math\.js\)\n  ⎿  Read 1 line$/m);
  assert.match(out, /^● Update\(math\.js\)\n  ⎿  Updated with 1 addition and 1 removal$/m);
  assert.match(out, /^     -export const add = \(a, b\) => a - b;$/m);
  assert.match(out, /^● Bash\(node -e .+\)\n  ⎿  5$/m);
  assert.match(out, /^Done \(3 tool uses · .+ · \$0\.\d{4} · 11\.7s\)$/m);
  assert.match(out, /session ses_\w+/);
});

test("summarize counts tools and sums cost", () => {
  const s = summarize(events);
  assert.equal(s.toolUses, 3);
  assert.ok(s.cost > 0);
});

test("reports tool errors and non-zero bash exits", () => {
  assert.deepEqual(toolResult("edit", { status: "error", error: "Found multiple matches" }), [
    "Error: Found multiple matches",
  ]);
  assert.deepEqual(toolResult("bash", { status: "completed", output: "boom\n", metadata: { exit: 2 } }), [
    "Exit code 2",
    "boom",
  ]);
  assert.deepEqual(toolResult("bash", { status: "completed", output: "", metadata: { exit: 0 } }), ["(No output)"]);
});

test("failed run renders as Failed with the error", () => {
  const out = formatTranscript({ events: [], model: "x/y", durationMs: 100, error: "Unexpected server error" }, "/work");
  assert.match(out, /● Error: Unexpected server error/);
  assert.match(out, /^Failed \(0 tool uses/m);
});

test("buildArgs always pins the directory and guards the prompt", () => {
  const args = buildArgs({ prompt: "-rf everything", cwd: "/repo", session: "ses_1" });
  assert.deepEqual(args.slice(-4), ["--dir", "/repo", "--", "-rf everything"]);
  assert.ok(args.includes("--session"));
});

test("stripCwd only shortens paths that start at a token boundary", () => {
  assert.equal(stripCwd("/work/src/a.ts", "/work"), "src/a.ts");
  assert.equal(stripCwd("see /work/a.ts and '/work/b.ts'", "/work"), "see a.ts and 'b.ts'");
  assert.equal(stripCwd("/home/u/work/x.js", "/work"), "/home/u/work/x.js");
  assert.equal(stripCwd("/a/b", "/"), "/a/b");
});

test("missing final answer is made explicit", () => {
  const toolOnly = events.filter((e) => e.type !== "text");
  const out = formatTranscript({ events: toolOnly, model: "x/y", durationMs: 1 }, "/work");
  assert.match(out, /● \(no final answer\)\n\nDone/);
});

test("nonexistent cwd fails fast with a clear error", async () => {
  const result = await runTask({ prompt: "hi", cwd: "/definitely/not/here" });
  assert.equal(result.error, "Working directory does not exist: /definitely/not/here");
});

const HANG = new URL("./fixtures/hang.mjs", import.meta.url).pathname;

async function hangingRun(opts: { signal?: AbortSignal; timeoutMs?: number }) {
  process.env.OPENCODE_BIN = HANG;
  try {
    const started = Date.now();
    const result = await runTask({ prompt: "hi", cwd: ".", ...opts });
    return { result, elapsed: Date.now() - started };
  } finally {
    delete process.env.OPENCODE_BIN;
  }
}

test("abort kills the whole process group, even with a grandchild holding stdout", async () => {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 500);
  const { result, elapsed } = await hangingRun({ signal: controller.signal });
  assert.equal(result.error, "Cancelled");
  assert.equal(result.sessionID, "ses_fake");
  assert.ok(elapsed < 4_000, `took ${elapsed}ms`);
});

test("timeout resolves promptly", async () => {
  const { result, elapsed } = await hangingRun({ timeoutMs: 500 });
  assert.match(result.error ?? "", /^Timed out/);
  assert.ok(elapsed < 4_000, `took ${elapsed}ms`);
});

test("apply_patch shows the patched files and multi-line output is relativized", async () => {
  const { formatTool } = await import("../src/format.ts");
  const patch = formatTool(
    {
      type: "tool",
      tool: "apply_patch",
      callID: "c1",
      state: { status: "completed", input: { patchText: "*** Begin Patch\n*** Update File: /work/math.js\n@@\n*** End Patch" }, output: "ok" },
    },
    "/work",
  );
  assert.match(patch, /^● Update\(math\.js\)/);
  const glob = formatTool(
    { type: "tool", tool: "glob", callID: "c2", state: { status: "completed", input: { pattern: "*" }, output: "/work/a.js\n/work/b/c.js" } },
    "/work",
  );
  assert.match(glob, /⎿  a\.js\n     b\/c\.js$/);
});

test("buildArgs passes the reasoning variant and the footer shows it", () => {
  assert.deepEqual(buildArgs({ prompt: "p", cwd: "/r", model: "a/b", variant: "high" }).slice(4, 8), ["-m", "a/b", "--variant", "high"]);
  assert.ok(!buildArgs({ prompt: "p", cwd: "/r" }).includes("--variant"));
  const out = formatTranscript({ events: [], model: "a/b", variant: "high", durationMs: 1 }, "/r");
  assert.match(out, /opencode · a\/b \(high\) · session/);
});

test("parseModels reads each model's variants from `opencode models --verbose` output", async () => {
  const { parseModels } = await import("../src/variants.ts");
  const out = [
    'openrouter/openai/gpt-6-luna\n{\n  "id": "openai/gpt-6-luna",\n  "note": "brace } in a string",\n  "variants": { "low": {"reasoning": {"effort": "low"}}, "max": {} }\n}',
    'openrouter/deepseek/deepseek-v4-flash\n{\n  "id": "deepseek/deepseek-v4-flash"\n}',
  ].join("\n");
  const models = parseModels(out);
  assert.deepEqual(models.get("openrouter/openai/gpt-6-luna"), ["low", "max"]);
  assert.deepEqual(models.get("openrouter/deepseek/deepseek-v4-flash"), []);
});

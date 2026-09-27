import assert from "node:assert/strict";
import { test } from "node:test";
import { cancelRun, startRun, waitRun } from "../src/runs.ts";

process.env.OPENCODE_BIN = new URL("./fixtures/steps.mjs", import.meta.url).pathname;
process.env.OPENCODE_DB = "/nonexistent/opencode.db";

async function drain(id: string, batchMs: number) {
  const batches: string[] = [];
  while (true) {
    const r = await waitRun(id, { batchMs, timeoutMs: 5_000 });
    batches.push(r.text);
    if (r.done) return { batches, last: r };
  }
}

test("start returns the session id before the run finishes", async () => {
  process.env.STEPS = "3";
  process.env.STEP_MS = "300";
  const started = await startRun({ prompt: "go", cwd: "." });
  assert.equal(started.id, "ses_steps");
  assert.equal(started.final, undefined);
  await drain(started.id, 0);
});

test("wait streams steps in batches and ends with a FINAL section", async () => {
  process.env.STEPS = "4";
  process.env.STEP_MS = "250";
  const { id } = await startRun({ prompt: "go", cwd: "." });
  const { batches, last } = await drain(id, 0);
  assert.ok(batches.length >= 3, `expected incremental batches, got ${batches.length}`);
  const all = batches.join("\n");
  for (let i = 1; i <= 4; i++) assert.equal(all.split(`Bash(echo ${i})`).length - 1, 1, `step ${i} delivered once`);
  assert.equal(last.done, true);
  assert.match(last.text, /=== FINAL ===\nall steps done\n\nDone \(4 tool uses/);
  assert.equal(last.text.split("all steps done").length - 1, 1, "final answer not printed twice");
});

test("cancel stops a run and wait reports it", async () => {
  process.env.STEPS = "50";
  process.env.STEP_MS = "200";
  const { id } = await startRun({ prompt: "go", cwd: "." });
  assert.equal(cancelRun(id), true);
  const { last } = await drain(id, 0);
  assert.equal(last.isError, true);
  assert.match(last.text, /=== FINAL ===\nError: Cancelled/);
});

test("aborting a wait (caller stopped) cancels the run", async () => {
  process.env.STEPS = "50";
  process.env.STEP_MS = "200";
  const { id } = await startRun({ prompt: "go", cwd: "." });
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 300);
  const r = await waitRun(id, { signal: controller.signal, timeoutMs: 10_000 });
  assert.equal(r.done, true);
  assert.match(r.text, /Error: Cancelled/);
});

test("unknown id is an error", async () => {
  const r = await waitRun("ses_nope");
  assert.deepEqual([r.done, r.isError], [true, true]);
});

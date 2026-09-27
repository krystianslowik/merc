import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type RequestListener } from "node:http";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { formatTranscript } from "../src/format.ts";
import { runTask, type TaskOptions } from "../src/opencode.ts";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const FIXTURE = fileURLToPath(new URL("./fixtures/attached.mjs", import.meta.url));
const user = { info: { role: "user" }, parts: [] };
const answer = { id: "answer", type: "text", text: "Finished the task.", time: { end: 1 } };
const start = { id: "start", type: "step-start" };
const terminal = { info: { role: "assistant", time: { completed: 1 }, finish: "stop" }, parts: [answer] };
const toolStep = {
  info: { role: "assistant", time: { completed: 1 }, finish: "tool-calls" },
  parts: [start, { id: "step", type: "step-finish", reason: "tool-calls" }],
};

async function mockServer(t: TestContext, handler: RequestListener, abortDelayMs = 0) {
  const aborts: string[] = [];
  const completedAborts: string[] = [];
  const server = createServer((req, res) => {
    if (req.method === "POST" && req.url?.endsWith("/abort")) {
      const url = req.url;
      aborts.push(url);
      const respond = () => { completedAborts.push(url); res.end("{}"); };
      if (abortDelayMs) {
        const timer = setTimeout(respond, abortDelayMs);
        t.after(() => clearTimeout(timer));
      } else respond();
      return;
    }
    handler(req, res);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return { url: `http://127.0.0.1:${address.port}`, aborts, completedAborts };
}

async function attached(url: string, opts: Partial<TaskOptions> = {}) {
  const previous = process.env.OPENCODE_BIN;
  process.env.OPENCODE_BIN = FIXTURE;
  try {
    return await runTask({ prompt: "exit", cwd: ROOT, attach: url, timeoutMs: 5_000, backfillTimeoutMs: 3_000, ...opts });
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_BIN;
    else process.env.OPENCODE_BIN = previous;
  }
}

for (const [name, final] of [
  ["assistant finish", terminal],
  ["terminal step-finish", {
    info: { role: "assistant", time: { completed: 1 } },
    parts: [answer, { id: "final-step", type: "step-finish", reason: "stop" }],
  }],
] as const) {
  test(`backfill waits past tool-calls for ${name} and deduplicates streamed parts`, async (t) => {
    let requests = 0;
    const server = await mockServer(t, (req, res) => {
      assert.equal(req.url, "/session/ses_attach/message");
      requests++;
      res.end(JSON.stringify(requests === 1 ? [user, toolStep] : [user, toolStep, final]));
    });
    const streamed: string[] = [];
    const result = await attached(server.url, { onEvent: (event) => streamed.push(event.type) });
    assert.equal(result.error, undefined);
    assert.equal(requests, 2);
    assert.equal(result.events.filter((event) => event.type === "step_start").length, 1);
    assert.deepEqual(result.events.find((event) => event.type === "text")?.part, answer);
    assert.ok(streamed.includes("text"));
    assert.deepEqual(server.aborts, []);
  });
}

for (const [name, incomplete] of [
  ["timestamps without a finish reason", { info: { role: "assistant", time: { completed: 1 } }, parts: [] }],
  ["finish reason without completion", { info: { role: "assistant", finish: "stop" }, parts: [answer] }],
] as const) {
  test(`backfill does not finish on ${name}`, async (t) => {
    let requests = 0;
    const server = await mockServer(t, (_req, res) => {
      res.end(JSON.stringify([user, ++requests === 1 ? incomplete : terminal]));
    });
    const result = await attached(server.url);
    assert.equal(result.error, undefined);
    assert.equal(requests, 2);
    assert.deepEqual(result.events.find((event) => event.type === "text")?.part, answer);
  });
}

test("backfill surfaces assistant errors even without a terminal finish reason", async (t) => {
  const failure = { name: "APIError", data: { message: "provider quota exhausted" } };
  const server = await mockServer(t, (_req, res) => {
    res.end(JSON.stringify([user, {
      info: { role: "assistant", time: { completed: 1 }, error: failure }, parts: [],
    }]));
  });
  const result = await attached(server.url);
  assert.equal(result.error, failure.data.message);
  assert.deepEqual(result.events.find((event) => event.type === "error")?.error, failure);
  assert.match(formatTranscript(result, ROOT), /Failed \(/);
});

for (const [name, handler, expected] of [
  ["HTTP 503", (_req, res) => { res.writeHead(503); res.end("unavailable"); }, /Backfill.*HTTP 503/],
  ["invalid JSON", (_req, res) => { res.end("not JSON"); }, /Backfill failed:/],
  ["invalid message payload", (_req, res) => { res.end("{}"); }, /Backfill failed:/],
  ["disconnected server", (req) => { req.socket.destroy(); }, /Backfill failed:/],
] satisfies [string, RequestListener, RegExp][]) {
  test(`backfill reports ${name} instead of success`, async (t) => {
    const server = await mockServer(t, handler);
    const result = await attached(server.url);
    assert.match(result.error ?? "", expected);
    assert.match(formatTranscript(result, ROOT), /Failed \(/);
    assert.deepEqual(server.aborts, ["/session/ses_attach/abort"]);
  });
}

test("cancellation interrupts a backfill fetch and aborts the remote turn", async (t) => {
  const controller = new AbortController();
  const server = await mockServer(t, () => { controller.abort(); });
  const started = Date.now();
  const result = await attached(server.url, { signal: controller.signal });
  assert.equal(result.error, "Cancelled");
  assert.ok(Date.now() - started < 2_000);
  assert.deepEqual(server.aborts, ["/session/ses_attach/abort"]);
});

test("cancellation interrupts the backfill polling delay", async (t) => {
  const controller = new AbortController();
  let requests = 0;
  const server = await mockServer(t, (_req, res) => {
    requests++;
    res.end(JSON.stringify([user, toolStep]));
    const timer = setTimeout(() => controller.abort(), 100);
    t.after(() => clearTimeout(timer));
  });
  const started = Date.now();
  const result = await attached(server.url, { signal: controller.signal });
  assert.equal(result.error, "Cancelled");
  assert.equal(requests, 1);
  assert.ok(Date.now() - started < 1_000);
  assert.deepEqual(server.aborts, ["/session/ses_attach/abort"]);
});

test("the task deadline still applies after the attached client exits", async (t) => {
  let requests = 0;
  const server = await mockServer(t, () => { requests++; });
  const result = await attached(server.url, { timeoutMs: 1_000 });
  assert.equal(requests, 1);
  assert.match(result.error ?? "", /^Timed out after 1s$/);
  assert.deepEqual(server.aborts, ["/session/ses_attach/abort"]);
});

for (const [name, handler] of [
  ["fetch", () => {}],
  ["polling delay", (_req, res) => { res.end(JSON.stringify([user, toolStep])); }],
  ["response body", (_req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.write("["); }],
] satisfies [string, RequestListener][]) {
  test(`the backfill deadline interrupts ${name} and reports failure`, async (t) => {
    const server = await mockServer(t, handler);
    const result = await attached(server.url, { backfillTimeoutMs: 150 });
    assert.match(result.error ?? "", /Backfill timed out after 150ms/);
    assert.deepEqual(server.aborts, ["/session/ses_attach/abort"]);
    assert.ok(result.durationMs < 2_000);
  });
}

test("cancelling before the first event aborts the supplied continuation session", async (t) => {
  const controller = new AbortController();
  const server = await mockServer(t, (req, res) => {
    assert.equal(req.url, "/accepted");
    res.end("{}");
    controller.abort();
  });
  const result = await attached(server.url, { prompt: "silent", session: "ses_known", signal: controller.signal });
  assert.equal(result.error, "Cancelled");
  assert.equal(result.sessionID, "ses_known");
  assert.equal(result.events.length, 0);
  assert.deepEqual(server.aborts, ["/session/ses_known/abort"]);
});

test("an emitted session ID takes precedence over the supplied session", async (t) => {
  const server = await mockServer(t, (req, res) => {
    assert.equal(req.url, "/session/ses_attach/message");
    res.end(JSON.stringify([user, terminal]));
  });
  const result = await attached(server.url, { session: "ses_previous" });
  assert.equal(result.error, undefined);
  assert.equal(result.sessionID, "ses_attach");
});

test("cancellation also aborts a different session learned while draining stdout", async (t) => {
  const controller = new AbortController();
  const server = await mockServer(t, (req, res) => {
    assert.equal(req.url, "/accepted");
    res.end("{}");
    controller.abort();
  }, 100);
  const result = await attached(server.url, { prompt: "late", session: "ses_known", signal: controller.signal });
  assert.equal(result.error, "Cancelled");
  assert.equal(result.sessionID, "ses_attach");
  const expected = ["/session/ses_attach/abort", "/session/ses_known/abort"];
  assert.deepEqual(server.aborts.toSorted(), expected);
  assert.deepEqual(server.completedAborts.toSorted(), expected);
});

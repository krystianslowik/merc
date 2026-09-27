import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type { OpencodeEvent } from "../src/opencode.ts";

// A minimal copy of opencode's schema, enough for the queries the bridge runs.
const dbFile = join(mkdtempSync(join(tmpdir(), "oc-store-")), "opencode.db");
process.env.OPENCODE_DB = dbFile;
const db = new DatabaseSync(dbFile);
db.exec(`
  create table session (id text primary key, parent_id text, directory text not null, model text, cost real default 0 not null,
    time_created integer not null, time_updated integer not null);
  create table message (id text primary key, session_id text not null, time_created integer not null, data text not null);
  create table part (id text primary key, message_id text not null, session_id text not null,
    time_created integer not null, time_updated integer not null, data text not null);
`);
const addSession = (id: string, parent: string | null, cost: number, created: number) =>
  db.prepare("insert into session values (?, ?, '/work', ?, ?, ?, ?)").run(
    id, parent, JSON.stringify({ providerID: "openrouter", modelID: "openai/gpt-6-astra" }), cost, created, created,
  );
const addPart = (id: string, session: string, updated: number, data: object) =>
  db.prepare("insert into part values (?, 'msg', ?, ?, ?, ?)").run(id, session, updated, updated, JSON.stringify(data));

const { follow, latestSession, sessionInfo, turnStart } = await import("../src/store.ts");

test("sessionInfo reports the real model and only sub-agents spawned since the run started", () => {
  addSession("ses_root", null, 4, 1_000);
  addSession("ses_old_sub", "ses_root", 9, 1_500);
  addSession("ses_sub", "ses_root", 2, 3_000);
  addSession("ses_subsub", "ses_sub", 0.5, 3_500);
  assert.deepEqual(sessionInfo("ses_root", 2_000), { model: "openrouter/openai/gpt-6-astra", subSessions: 2, subCost: 2.5 });
  assert.equal(sessionInfo("ses_missing"), undefined);
  assert.equal(latestSession("/work"), "ses_root");
});

test("turnStart finds the latest user message", () => {
  db.prepare("insert into message values ('m1', 'ses_root', 100, ?)").run(JSON.stringify({ role: "user" }));
  db.prepare("insert into message values ('m2', 'ses_root', 200, ?)").run(JSON.stringify({ role: "assistant" }));
  db.prepare("insert into message values ('m3', 'ses_root', 300, ?)").run(JSON.stringify({ role: "user" }));
  assert.equal(turnStart("ses_root"), 300);
});

test("follow emits each part once, only when final, and picks up later updates", async () => {
  addPart("p1", "ses_root", 400, { type: "tool", tool: "bash", state: { status: "completed", input: {}, output: "one" } });
  addPart("p2", "ses_root", 400, { type: "text", text: "partial" });
  addPart("p0", "ses_root", 50, { type: "text", text: "before the turn", time: { end: 60 } });
  const seen: OpencodeEvent[] = [];
  const controller = new AbortController();
  const following = follow("ses_root", (e) => seen.push(e), { signal: controller.signal, since: 300, intervalMs: 20 });
  await new Promise((r) => setTimeout(r, 80));
  db.prepare("update part set data = ?, time_updated = 500 where id = 'p2'").run(
    JSON.stringify({ type: "text", text: "final answer", time: { end: 500 } }),
  );
  await new Promise((r) => setTimeout(r, 80));
  controller.abort();
  await following;
  assert.deepEqual(
    seen.map((e) => [e.type, (e.part as { text?: string }).text ?? (e.part as { tool?: string }).tool]),
    [["tool_use", "bash"], ["text", "final answer"]],
  );
});

test("activeSessions reports the latest assistant step, tool count and turn cost", async () => {
  const { activeSessions } = await import("../src/store.ts");
  const now = Date.now();
  db.prepare("insert into session values ('ses_live', null, '/work', ?, 0, ?, ?)").run(
    JSON.stringify({ providerID: "openrouter", modelID: "openai/gpt-6-luna" }), now, now,
  );
  db.prepare("insert into message values ('mu', 'ses_live', ?, ?)").run(now - 1_000, JSON.stringify({ role: "user" }));
  db.prepare("insert into message values ('ma', 'ses_live', ?, ?)").run(now - 900, JSON.stringify({ role: "assistant" }));
  const add = (id: string, msg: string, data: object) =>
    db.prepare("insert into part values (?, ?, 'ses_live', ?, ?, ?)").run(id, msg, now - 500, now - 500, JSON.stringify(data));
  add("u1", "mu", { type: "text", text: "the user prompt" });
  add("a1", "ma", { type: "tool", tool: "bash", state: { status: "running", input: { command: "sleep 5" } } });
  add("a2", "ma", { type: "step-finish", cost: 0.002 });
  const [live] = activeSessions(5_000);
  assert.equal(live.id, "ses_live");
  assert.equal(live.model, "openrouter/openai/gpt-6-luna");
  assert.equal(live.tools, 1);
  assert.equal(live.cost, 0.002);
  assert.equal((live.latest?.part as { tool?: string }).tool, "bash");
});

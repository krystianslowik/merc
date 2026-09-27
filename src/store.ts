import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { OpencodeEvent, Part } from "./opencode.ts";

// Read-only access to opencode's local store, which it writes as a run progresses.

export function dbPath(): string {
  if (process.env.OPENCODE_DB) return process.env.OPENCODE_DB;
  const data = process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
  return join(data, "opencode", "opencode.db");
}

function open(): DatabaseSync | undefined {
  const path = dbPath();
  if (!existsSync(path)) return undefined;
  try {
    return new DatabaseSync(path, { readOnly: true });
  } catch {
    return undefined;
  }
}

export interface SessionInfo {
  model?: string;
  /** Sub-agent sessions spawned (at any depth) since `since`, and what they cost. */
  subSessions: number;
  subCost: number;
}

export function sessionInfo(sessionID: string, since = 0): SessionInfo | undefined {
  const db = open();
  if (!db) return undefined;
  try {
    const row = db.prepare("select model from session where id = ?").get(sessionID) as { model: string | null } | undefined;
    if (!row) return undefined;
    const tree = db
      .prepare(
        `with recursive tree(id) as (select ? union all select s.id from session s join tree on s.parent_id = tree.id)
         select count(*) as subs, coalesce(sum(s.cost), 0) as cost from session s join tree on s.id = tree.id
         where s.id != ? and s.time_created >= ?`,
      )
      .get(sessionID, sessionID, since) as { subs: number; cost: number };
    return { model: parseModel(row.model), subSessions: tree.subs, subCost: tree.cost };
  } catch {
    return undefined;
  } finally {
    db.close();
  }
}

function parseModel(raw: string | null): string | undefined {
  if (!raw) return undefined;
  try {
    const model = JSON.parse(raw) as { providerID?: string; modelID?: string; id?: string };
    if (model.providerID && (model.modelID ?? model.id)) return `${model.providerID}/${model.modelID ?? model.id}`;
  } catch {
    // Plain string.
  }
  return raw;
}

export function latestSession(directory?: string): string | undefined {
  const db = open();
  if (!db) return undefined;
  try {
    const row = (
      directory
        ? db.prepare("select id from session where parent_id is null and directory = ? order by time_updated desc limit 1").get(directory)
        : db.prepare("select id from session where parent_id is null order by time_updated desc limit 1").get()
    ) as { id: string } | undefined;
    return row?.id;
  } finally {
    db.close();
  }
}

/** When the session's latest user message was sent, i.e. the start of the current turn. */
export function turnStart(sessionID: string): number | undefined {
  const db = open();
  if (!db) return undefined;
  try {
    return turnStartIn(db, sessionID);
  } finally {
    db.close();
  }
}

function turnStartIn(db: DatabaseSync, sessionID: string): number | undefined {
  const row = db
    .prepare("select time_created from message where session_id = ? and json_extract(data, '$.role') = 'user' order by time_created desc limit 1")
    .get(sessionID) as { time_created: number } | undefined;
  return row?.time_created;
}

export interface ActiveSession {
  id: string;
  model?: string;
  cost: number;
  tools: number;
  /** Latest part that changed, for a one-line "what is it doing now". */
  latest?: OpencodeEvent;
}

/** Top-level sessions that changed within `withinMs`, newest first. */
export function activeSessions(withinMs = 20_000, directory?: string): ActiveSession[] {
  const db = open();
  if (!db) return [];
  try {
    const since = Date.now() - withinMs;
    const rows = db
      .prepare(
        `select id, model from session where parent_id is null and time_updated >= ?${directory ? " and directory = ?" : ""}
         order by time_updated desc limit 3`,
      )
      .all(...(directory ? [since, directory] : [since])) as { id: string; model: string | null }[];
    return rows.map((row) => {
      const turn = turnStartIn(db, row.id) ?? 0;
      const parts = db
        .prepare(
          `select p.data from part p join message m on m.id = p.message_id
           where p.session_id = ? and p.time_updated >= ? and json_extract(m.data, '$.role') = 'assistant' order by p.time_updated`,
        )
        .all(row.id, turn) as { data: string }[];
      let cost = 0;
      let tools = 0;
      let latest: OpencodeEvent | undefined;
      for (const { data } of parts) {
        const part = JSON.parse(data) as StoredPart & { cost?: number };
        if (part.type === "step-finish") cost += part.cost ?? 0;
        if (part.type === "tool") tools++;
        if (part.type === "tool" || part.type === "text") latest = { type: EVENT_TYPE[part.type], timestamp: 0, sessionID: row.id, part };
      }
      return { id: row.id, model: parseModel(row.model), cost, tools, latest };
    });
  } catch {
    return [];
  } finally {
    db.close();
  }
}

interface PartRow {
  id: string;
  time_updated: number;
  data: string;
}

type StoredPart = Part & { time?: { end?: number }; state?: { status: string } };

/** A part is final once its text is complete or its tool call has a result. */
function isFinal(part: StoredPart): boolean {
  if (part.type === "text") return Boolean(part.time?.end);
  if (part.type === "tool") return part.state?.status === "completed" || part.state?.status === "error";
  return part.type === "step-finish";
}

const EVENT_TYPE: Record<string, string> = { text: "text", tool: "tool_use", "step-finish": "step_finish" };

/**
 * Follows a session in opencode's store and emits each part once it is final.
 * Resolves when the signal aborts.
 */
export async function follow(
  sessionID: string,
  onEvent: (event: OpencodeEvent) => void,
  opts: { signal?: AbortSignal; intervalMs?: number; since?: number } = {},
): Promise<void> {
  const db = open();
  if (!db) throw new Error(`opencode database not found at ${dbPath()}`);
  const query = db.prepare("select id, time_updated, data from part where session_id = ? and time_updated >= ? order by id");
  const emitted = new Set<string>();
  let since = opts.since ?? Date.now();
  try {
    while (!opts.signal?.aborted) {
      for (const row of query.all(sessionID, since) as unknown as PartRow[]) {
        since = Math.max(since, row.time_updated);
        if (emitted.has(row.id)) continue;
        const part = JSON.parse(row.data) as StoredPart;
        if (!EVENT_TYPE[part.type] || !isFinal(part)) continue;
        emitted.add(row.id);
        onEvent({ type: EVENT_TYPE[part.type], timestamp: row.time_updated, sessionID, part });
      }
      await new Promise((r) => setTimeout(r, opts.intervalMs ?? 500));
    }
  } finally {
    db.close();
  }
}

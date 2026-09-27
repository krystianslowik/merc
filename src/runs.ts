import { formatEvent, formatFooter } from "./format.ts";
import { runTask, type TaskOptions, type TaskResult } from "./opencode.ts";

// Background runs that a caller polls in batches. Claude Code only renders a tool result when the call returns,
// so a relay agent calling `wait` in a loop is what makes the transcript appear step by step.

interface Run {
  id: string;
  cwd: string;
  blocks: string[];
  cursor: number;
  result?: TaskResult;
  /** Whether the newest block is assistant text, i.e. possibly the final answer. */
  lastIsText: boolean;
  controller: AbortController;
  waiters: Set<() => void>;
  lastPoll: number;
}

const runs = new Map<string, Run>();
let counter = 0;

const START_WAIT_MS = 15_000;
/** A run nobody polls for this long is assumed abandoned (the relay agent was stopped) and cancelled. */
const ABANDON_MS = 10 * 60 * 1000;
/** Finished runs are kept this long for a late `wait`. */
const KEEP_MS = 30 * 60 * 1000;

function changed(run: Run): Promise<void> {
  return new Promise((resolve) => run.waiters.add(resolve));
}

function notify(run: Run): void {
  for (const resolve of run.waiters) resolve();
  run.waiters.clear();
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

export interface StartResult {
  id: string;
  sessionID?: string;
  /** Present when the run already finished (typically a startup error). */
  final?: string;
}

export async function startRun(opts: Omit<TaskOptions, "signal" | "onEvent">): Promise<StartResult> {
  const run: Run = {
    id: `run_${++counter}`,
    cwd: opts.cwd,
    blocks: [],
    cursor: 0,
    lastIsText: false,
    controller: new AbortController(),
    waiters: new Set(),
    lastPoll: Date.now(),
  };
  runs.set(run.id, run);
  let sessionID: string | undefined;
  const known = changed(run);

  void runTask({
    ...opts,
    signal: run.controller.signal,
    onEvent: (event) => {
      if (!sessionID && event.sessionID) {
        sessionID = event.sessionID;
        runs.set(sessionID, run);
      }
      const block = formatEvent(event, opts.cwd);
      if (block) {
        run.blocks.push(block);
        run.lastIsText = event.part?.type === "text";
      }
      notify(run);
    },
  }).then((result) => {
    run.result = result;
    if (result.sessionID) runs.set(result.sessionID, run);
    notify(run);
    setTimeout(() => forget(run), KEEP_MS).unref();
  });

  const watchdog = setInterval(() => {
    if (run.result) return clearInterval(watchdog);
    if (Date.now() - run.lastPoll > ABANDON_MS) run.controller.abort();
  }, 30_000);
  watchdog.unref();

  await Promise.race([known, sleep(START_WAIT_MS)]);
  const id = sessionID ?? run.result?.sessionID;
  return { id: id ?? run.id, sessionID: id, final: run.result && !run.blocks.length ? finalSection(run) : undefined };
}

function forget(run: Run): void {
  for (const [key, value] of runs) if (value === run) runs.delete(key);
}

function finalSection(run: Run): string {
  const result = run.result!;
  const answer = result.events.findLast((e) => formatEvent(e, run.cwd))?.part;
  const text =
    result.error ? `Error: ${result.error}` : answer?.type === "text" && "text" in answer ? answer.text.trim() : "(no final answer)";
  return `=== FINAL ===\n${text}\n\n${formatFooter(result)}`;
}

export interface WaitResult {
  text: string;
  done: boolean;
  isError: boolean;
}

/**
 * Returns the steps completed since the previous wait. Blocks until the run finishes, or new steps have
 * arrived and `batchMs` has passed, or `timeoutMs` elapses with nothing new.
 */
export async function waitRun(
  id: string,
  opts: { timeoutMs?: number; batchMs?: number; signal?: AbortSignal } = {},
): Promise<WaitResult> {
  const run = runs.get(id);
  if (!run) return { text: `Unknown or expired run: ${id}`, done: true, isError: true };
  run.lastPoll = Date.now();
  const started = Date.now();
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const batchMs = opts.batchMs ?? 5_000;

  while (!run.result && !opts.signal?.aborted) {
    const elapsed = Date.now() - started;
    if (elapsed >= timeoutMs) break;
    if (run.blocks.length > run.cursor && elapsed >= batchMs) break;
    await Promise.race([changed(run), sleep(Math.min(1_000, timeoutMs - elapsed), opts.signal)]);
  }
  // Cancelling the wait means the caller was stopped (Esc on the agent); do not leave opencode running unseen.
  if (opts.signal?.aborted && !run.result) {
    run.controller.abort();
    while (!run.result) await Promise.race([changed(run), sleep(1_000)]);
  }
  run.lastPoll = Date.now();

  let fresh = run.blocks.slice(run.cursor);
  run.cursor = run.blocks.length;
  if (!run.result) {
    const text = fresh.length ? fresh.join("\n\n") : `(still running · ${run.blocks.length} steps so far)`;
    return { text, done: false, isError: false };
  }
  // The final answer is repeated in the FINAL section, so do not print it twice.
  if (!run.result.error && fresh.length && run.lastIsText) fresh = fresh.slice(0, -1);
  return { text: [...fresh, finalSection(run)].join("\n\n"), done: true, isError: Boolean(run.result.error) };
}

export function cancelRun(id: string): boolean {
  const run = runs.get(id);
  if (!run || run.result) return false;
  run.controller.abort();
  return true;
}

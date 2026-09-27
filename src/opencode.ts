import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { type SessionInfo, sessionInfo } from "./store.ts";
import { checkVariant } from "./variants.ts";
import { createInterface } from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";

export interface ToolState {
  status: "pending" | "running" | "completed" | "error";
  input?: Record<string, unknown>;
  output?: string;
  error?: string;
  title?: string;
  metadata?: Record<string, unknown>;
  time?: { start: number; end?: number };
}

export type Part =
  | { type: "text"; text: string }
  | { type: "tool"; tool: string; callID: string; state: ToolState }
  | { type: "step-start" }
  | {
      type: "step-finish";
      reason?: string;
      cost?: number;
      tokens?: { input: number; output: number; reasoning: number; cache?: { read: number; write: number } };
    }
  | { type: string };

export interface OpencodeEvent {
  type: string;
  timestamp: number;
  sessionID: string;
  part?: Part;
  error?: { name: string; data?: { message?: string } };
}

export interface TaskOptions {
  prompt: string;
  cwd: string;
  model?: string;
  /** Provider-specific reasoning effort, e.g. minimal, low, medium, high, max. */
  variant?: string;
  agent?: string;
  session?: string;
  title?: string;
  /** URL of a running `opencode serve`, so the run can be watched with `opencode attach`. */
  attach?: string;
  timeoutMs?: number;
  backfillTimeoutMs?: number;
  /** Cancels the run: kills the opencode process group and aborts the server-side turn. */
  signal?: AbortSignal;
  onEvent?: (event: OpencodeEvent) => void;
}

export interface TaskResult {
  sessionID?: string;
  model?: string;
  variant?: string;
  events: OpencodeEvent[];
  error?: string;
  durationMs: number;
  /** From opencode's store: the model that actually ran and sub-agent sessions this run spawned. */
  session?: SessionInfo;
}

/** Unset means opencode picks its own configured default model. */
export const DEFAULT_MODEL = process.env.OPENCODE_BRIDGE_MODEL;
/** Unset means the model's default reasoning effort. */
export const DEFAULT_VARIANT = process.env.OPENCODE_BRIDGE_VARIANT;
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

export function buildArgs(opts: TaskOptions): string[] {
  const args = ["run", "--format", "json", "--auto"];
  const model = opts.model ?? DEFAULT_MODEL;
  if (model) args.push("-m", model);
  const variant = opts.variant ?? DEFAULT_VARIANT;
  if (variant) args.push("--variant", variant);
  if (opts.agent) args.push("--agent", opts.agent);
  if (opts.session) args.push("--session", opts.session);
  if (opts.title) args.push("--title", opts.title);
  // opencode resolves its project from --dir / $PWD, not the process cwd.
  args.push("--dir", opts.cwd);
  if (opts.attach) args.push("--attach", opts.attach);
  // "--" keeps prompts that start with "-" from being parsed as flags.
  args.push("--", opts.prompt);
  return args;
}

/** Process groups of runs still in flight, killed if the bridge itself exits. */
const active = new Set<number>();
const running = new Set<(reason: string) => Promise<void>>();
process.on("exit", () => {
  for (const pid of active) killGroup(pid, "SIGKILL");
});
let exiting = false;
function shutdown(signal: "SIGINT" | "SIGTERM"): void {
  const code = signal === "SIGINT" ? 130 : 143;
  if (exiting) process.exit(code);
  exiting = true;
  void Promise.all([...running].map((stop) => stop(`Cancelled by ${signal}`))).finally(() => process.exit(code));
}
export function interrupt(): void { shutdown("SIGINT"); }
process.on("SIGINT", interrupt);
process.on("SIGTERM", () => shutdown("SIGTERM"));

function killGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid) return;
  try {
    process.kill(-pid, signal);
  } catch {
    // Already gone.
  }
}

async function cleanupGroup(pid: number | undefined): Promise<void> {
  if (!pid) return;
  killGroup(pid, "SIGTERM");
  let deadline = Date.now() + 5_000;
  let escalated = false;
  while (true) {
    try {
      process.kill(-pid, 0);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ESRCH") {
        active.delete(pid);
        return;
      }
      if (code !== "EPERM") throw err;
    }
    if (Date.now() >= deadline) {
      if (escalated) throw new Error(`Process group ${pid} did not exit after SIGKILL`);
      killGroup(pid, "SIGKILL");
      escalated = true;
      deadline = Date.now() + 1_000;
    }
    await sleep(50);
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function runTask(opts: TaskOptions): Promise<TaskResult> {
  const started = Date.now();
  const events: OpencodeEvent[] = [];
  const bin = process.env.OPENCODE_BIN ?? "opencode";
  const cwd = resolve(opts.cwd);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const sessionID = () => events.find((e) => e.sessionID)?.sessionID ?? opts.session;
  const finish = (error?: string): TaskResult => {
    const id = sessionID();
    return {
      sessionID: id,
      model: opts.model ?? DEFAULT_MODEL,
      variant: opts.variant ?? DEFAULT_VARIANT,
      events,
      error,
      durationMs: Date.now() - started,
      session: id ? sessionInfo(id, started) : undefined,
    };
  };

  if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
    return Promise.resolve(finish(`Working directory does not exist: ${cwd}`));
  }
  if (opts.signal?.aborted) return finish("Cancelled");
  const variantError = await checkVariant(opts.model ?? DEFAULT_MODEL, opts.variant ?? DEFAULT_VARIANT);
  if (variantError) return finish(variantError);

  return new Promise((resolvePromise) => {
    // Own process group, so a timeout or cancel also takes down opencode's children (shells, LSP, MCP servers).
    let child;
    try {
      child = spawn(bin, buildArgs({ ...opts, cwd }), {
        cwd,
        env: { ...process.env, PWD: cwd },
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      });
    } catch (err) {
      resolvePromise(finish(`Failed to start ${bin}: ${errorMessage(err)}`));
      return;
    }
    if (child.pid) active.add(child.pid);
    let stderrTail = "";
    let error: string | undefined;
    let stopped = false;
    let done = false;
    const controller = new AbortController();
    let cleanup: Promise<void> | undefined;
    const remoteAborts = new Map<string, Promise<void>>();
    const clean = () => (cleanup ??= cleanupGroup(child.pid).catch((err) => {
      const message = `Process cleanup failed: ${errorMessage(err)}`;
      error = error ? `${error}; ${message}` : message;
      stop(message);
      // A failed kill may leave the leader alive, so no exit event will complete the task.
      void complete(null);
    }));
    const abortTurn = () => {
      const id = sessionID();
      if (opts.attach && id && !remoteAborts.has(id)) remoteAborts.set(id, abortRemote(opts.attach, id));
    };

    const stop = (reason: string) => {
      if (stopped) return;
      stopped = true;
      error ??= reason;
      controller.abort(new Error(reason));
      void clean();
      // Killing the attached client does not stop the turn on the server.
      abortTurn();
    };
    let settled!: () => void;
    const completion = new Promise<void>((resolve) => { settled = resolve; });
    const shutdown = (reason: string) => { stop(reason); return completion; };
    running.add(shutdown);
    const timer = setTimeout(() => stop(`Timed out after ${Math.round(timeoutMs / 1000)}s`), timeoutMs);
    const onAbort = () => stop("Cancelled");
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    const receive = (event: OpencodeEvent) => {
      events.push(event);
      // opencode exits 0 on provider/model failures; the error only shows up as an event.
      if (event.type === "error") error ??= event.error?.data?.message ?? event.error?.name ?? "Unknown opencode error";
      if (stopped) abortTurn();
      try {
        opts.onEvent?.(event);
      } catch (err) {
        stop(`Event callback failed: ${errorMessage(err)}`);
      }
    };
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      if (!line.trim()) return;
      let event: OpencodeEvent;
      try {
        event = JSON.parse(line) as OpencodeEvent;
      } catch {
        return;
      }
      if (event && typeof event === "object") receive(event);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-4_000);
    });

    const complete = async (code: number | null) => {
      if (done) return;
      done = true;
      try {
        // Clean up on leader exit even if inherited pipes never close.
        const cleaning = clean();
        await new Promise<void>((resolve) => {
          const drained = () => {
            clearTimeout(drainTimer);
            child.stdout.removeListener("end", drained);
            resolve();
          };
          const drainTimer = setTimeout(drained, 1_000);
          child.stdout.once("end", drained);
          if (child.stdout.readableEnded || child.stdout.destroyed) drained();
        });
        lines.close();
        child.stdout.destroy();
        child.stderr.destroy();
        await cleaning;
        if (!error && code !== 0) error = `opencode exited with code ${code}: ${stderrTail.trim().slice(-500)}`;
        const id = sessionID();
        if (opts.attach && id && child.pid && !stopped) {
          for (const event of await missedEvents(opts.attach, id, events, controller.signal, opts.backfillTimeoutMs)) {
            if (stopped) break;
            receive(event);
          }
        }
      } catch (err) {
        stop(errorMessage(err));
      } finally {
        await clean();
        if (stopped) abortTurn();
        await Promise.all(remoteAborts.values());
        clearTimeout(timer);
        opts.signal?.removeEventListener("abort", onAbort);
        running.delete(shutdown);
        resolvePromise(finish(error));
        settled();
      }
    };

    child.on("error", (err) => {
      error ??= `Failed to start ${bin}: ${err.message}`;
      void complete(null);
    });
    child.on("exit", (code) => { void complete(code); });
    if (opts.signal?.aborted) onAbort();
  });
}

interface ServerMessage {
  info: { role: string; time?: { completed?: number }; finish?: string; error?: OpencodeEvent["error"] };
  parts: (Part & { id?: string; callID?: string; time?: { end?: number } })[];
}

const EVENT_TYPE: Record<string, string> = {
  text: "text",
  tool: "tool_use",
  "step-start": "step_start",
  "step-finish": "step_finish",
};

const BACKFILL_WAIT_MS = 60_000;

function serverUrl(base: string, path: string): URL {
  // Relative resolution keeps any path prefix of a proxied server URL.
  return new URL(path, base.endsWith("/") ? base : `${base}/`);
}

async function abortRemote(url: string, sessionID: string): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  try {
    const res = await fetch(serverUrl(url, `session/${sessionID}/abort`), {
      method: "POST",
      headers: authHeader(),
      signal: controller.signal,
    });
    await res.body?.cancel();
  } catch {
    // Best effort.
  } finally {
    clearTimeout(timer);
  }
}

/**
 * `opencode run --attach` can exit before the final parts are streamed (the server still completes the turn),
 * so wait for the server to finish the latest assistant turn and return the parts the stream did not deliver.
 */
async function missedEvents(
  url: string, sessionID: string, seen: OpencodeEvent[], signal: AbortSignal, timeoutMs = BACKFILL_WAIT_MS,
): Promise<OpencodeEvent[]> {
  const seenIds = new Set(
    seen.map((e) => e.part as { id?: string; callID?: string } | undefined).map((p) => p?.id ?? p?.callID),
  );
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`Backfill timed out after ${timeoutMs}ms`)), timeoutMs);
  const polling = AbortSignal.any([signal, controller.signal]);
  try {
    while (true) {
      polling.throwIfAborted();
      const res = await fetch(serverUrl(url, `session/${sessionID}/message`), {
        headers: authHeader(),
        signal: AbortSignal.any([polling, AbortSignal.timeout(10_000)]),
      });
      if (!res.ok) {
        await res.body?.cancel();
        throw new Error(`Backfill HTTP ${res.status}: ${res.statusText}`);
      }
      const messages = (await res.json()) as ServerMessage[];
      polling.throwIfAborted();
      const turn = messages.slice(messages.findLastIndex((m) => m.info.role === "user") + 1);
      const last = turn.findLast((m) => m.info.role === "assistant");
      const reason = last?.info.finish ?? (last?.parts.findLast((p) => p.type === "step-finish") as { reason?: string } | undefined)?.reason;
      const finished = typeof last?.info.time?.completed === "number" && Boolean(reason) && reason !== "tool-calls";
      const errors: OpencodeEvent[] = turn.filter((m) => m.info.error).map((m) => ({
        type: "error", timestamp: Date.now(), sessionID, error: m.info.error,
      }));
      if (finished || errors.length) {
        return [...errors, ...turn
          .flatMap((m) => m.parts)
          .filter((part) => EVENT_TYPE[part.type] && !seenIds.has(part.id ?? part.callID))
          .filter((part) => part.type !== "text" || part.time?.end)
          .filter((part) => part.type !== "tool" || ["completed", "error"].includes((part as { state: ToolState }).state.status))
          .map((part) => ({ type: EVENT_TYPE[part.type], timestamp: Date.now(), sessionID, part }))];
      }
      await sleep(1_000, undefined, { signal: polling });
    }
  } catch (err) {
    throw new Error(`Backfill failed: ${errorMessage(polling.aborted ? polling.reason : err)}`);
  } finally {
    clearTimeout(timer);
  }
}

function authHeader(): Record<string, string> {
  const password = process.env.OPENCODE_SERVER_PASSWORD;
  if (!password) return {};
  const user = process.env.OPENCODE_SERVER_USERNAME ?? "opencode";
  return { authorization: `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}` };
}

import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { runTask, type TaskResult } from "../src/opencode.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const fixture = fileURLToPath(new URL("./fixtures/process.mjs", import.meta.url));
const options = { timeout: 25_000, skip: process.platform === "win32", concurrency: false };
type Tree = { leader: number; middle: number; grandchild: number };
type RecordEntry = { kind: string; role: string; pid: number; tree?: Tree };
type Bridge = {
  child: ChildProcessWithoutNullStreams;
  stdout: string;
  stderr: string;
  exited: boolean;
  error?: Error;
};

function exists(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") return true;
    assert.equal((error as NodeJS.ErrnoException).code, "ESRCH");
    return false;
  }
}

function gone(tree: Tree): void {
  for (const [role, pid] of Object.entries(tree)) {
    assert.equal(exists(pid), false, `${role} PID ${pid} must be ESRCH at completion`);
  }
  assert.equal(exists(-tree.leader), false, `process group ${tree.leader} must be ESRCH at completion`);
}

async function until(check: () => boolean, label: string, timeout = 3_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!check()) {
    assert.ok(Date.now() < deadline, `Timed out waiting for ${label}`);
    await sleep(20);
  }
}

async function withFixture(mode: "normal" | "wait", body: (scope: {
  env: NodeJS.ProcessEnv;
  records: () => RecordEntry[];
  ready: () => Promise<Tree>;
  launch: (entry: "cli" | "mcp", args?: string[]) => Bridge;
}) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "bridge-process-"));
  const env: NodeJS.ProcessEnv = { ...process.env, OPENCODE_BIN: fixture, PROCESS_TEST_DIR: dir, PROCESS_TEST_MODE: mode };
  delete env.OPENCODE_SERVER_URL;
  const bridges: Bridge[] = [];
  const records = (): RecordEntry[] => {
    try { return readFileSync(join(dir, "processes.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  };
  try {
    await body({
      env, records,
      ready: async () => {
        await until(() => Boolean(records().find((entry) => entry.kind === "ready")), "fixture readiness");
        return records().find((entry) => entry.kind === "ready")!.tree!;
      },
      launch: (entry, args = []) => {
        const child = spawn(process.execPath, [join(root, "src", `${entry}.ts`), ...args], {
          cwd: root, env, detached: true, stdio: "pipe",
        });
        const bridge: Bridge = { child, stdout: "", stderr: "", exited: false };
        bridges.push(bridge);
        child.stdout.setEncoding("utf8").on("data", (chunk: string) => { bridge.stdout += chunk; });
        child.stderr.setEncoding("utf8").on("data", (chunk: string) => { bridge.stderr += chunk; });
        child.on("error", (error) => { bridge.error = error; });
        child.once("exit", () => { bridge.exited = true; });
        // A dying peer can close stdin between a readiness check and a write.
        child.stdin.on("error", (error) => { bridge.error = error; });
        return bridge;
      },
    });
  } finally {
    // Stop bridges before reading the journal so none can start another task.
    const kill = (pid: number) => {
      try { process.kill(pid, "SIGKILL"); }
      catch (error) {
        // macOS can return EPERM for an already-killed, not-yet-reaped group.
        // The ESRCH polling below still requires every process to disappear.
        assert.ok(["ESRCH", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? ""));
      }
    };
    try {
      for (const { child } of bridges) if (child.pid) kill(-child.pid);
      try {
        await until(() => bridges.every(({ child, exited, error }) => exited || (!child.pid && Boolean(error))), "bridge cleanup");
      } finally {
        const entries = records().filter((entry) => entry.kind === "start");
        for (const entry of entries) if (entry.role === "leader") kill(-entry.pid);
        for (const entry of entries) kill(entry.pid);
        await until(() => entries.every(({ pid, role }) => !exists(pid) && (role !== "leader" || !exists(-pid))), "fixture ESRCH cleanup");
      }
    } finally {
      for (const { child } of bridges) {
        child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
      }
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

async function direct(mode: "normal" | "wait", body: (run: {
  task: Promise<TaskResult>;
  controller: AbortController;
  tree: Tree;
  draining: () => Promise<void>;
}) => Promise<void>): Promise<void> {
  await withFixture(mode, async (scope) => {
    const keys = ["OPENCODE_BIN", "OPENCODE_SERVER_URL", "PROCESS_TEST_DIR", "PROCESS_TEST_MODE"];
    const previous = keys.map((key) => process.env[key]);
    const controller = new AbortController();
    let task: Promise<TaskResult> | undefined;
    let settled = false;
    try {
      for (const key of keys) {
        if (scope.env[key] === undefined) delete process.env[key];
        else process.env[key] = scope.env[key];
      }
      task = runTask({ prompt: "fixture", cwd: root, signal: controller.signal, timeoutMs: 12_000 });
      void task.then(() => { settled = true; });
      const tree = await scope.ready();
      await body({ task, controller, tree, draining: async () => {
        await until(() => scope.records().some((entry) => entry.kind === "term") && !exists(tree.leader), "leader exit and grandchild SIGTERM");
        assert.equal(exists(tree.grandchild), true, "grandchild must survive SIGTERM");
        assert.equal(settled, false, "runTask must wait after the short-lived leader exits");
      } });
    } finally {
      controller.abort();
      try { await task; }
      finally {
        keys.forEach((key, index) => {
          if (previous[index] === undefined) delete process.env[key];
          else process.env[key] = previous[index];
        });
      }
    }
  });
}

test("normal leader exit escalates against a SIGTERM-resistant grandchild before resolving", options, async () => {
  await direct("normal", async ({ task, tree, draining }) => {
    await draining();
    const result = await task;
    gone(tree); // Deliberately no polling after resolution: cleanup is part of the result contract.
    assert.equal(result.error, undefined);
    assert.equal(result.sessionID, "ses_process_fixture");
    assert.ok(result.durationMs >= 4_900, `SIGKILL must follow the 5s grace, got ${result.durationMs}ms`);
  });
});

test("abort waits for SIGKILL escalation after the task leader exits", options, async () => {
  await direct("wait", async ({ task, controller, tree, draining }) => {
    const started = Date.now();
    controller.abort();
    await draining();
    const result = await task;
    gone(tree);
    assert.equal(result.error, "Cancelled");
    assert.ok(Date.now() - started >= 4_900, "abort must await the 5s cleanup grace");
  });
});

function send(bridge: Bridge, message: object): void {
  assert.equal(bridge.exited, false, bridge.stderr);
  assert.ifError(bridge.error);
  bridge.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
}

async function initialize(bridge: Bridge): Promise<void> {
  send(bridge, { id: 1, method: "initialize", params: {
    protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "process-test", version: "1.0.0" },
  } });
  const messages = () => bridge.stdout.split("\n").slice(0, -1).map((line) => JSON.parse(line));
  await until(() => {
    assert.ifError(bridge.error);
    assert.equal(bridge.exited, false, bridge.stderr);
    return messages().some((message) => message.id === 1);
  }, "MCP initialize response", 5_000);
  const response = messages().find((message) => message.id === 1);
  assert.equal(response.error, undefined);
  assert.equal(response.result.protocolVersion, "2025-11-25");
  assert.equal(response.result.serverInfo.name, "opencode");
  send(bridge, { method: "notifications/initialized" });
  send(bridge, { id: 2, method: "tools/call", params: { name: "task", arguments: { prompt: "fixture", cwd: root } } });
}

for (const [entry, signal, code] of [
  ["mcp", "SIGTERM", 143],
  ["mcp", "SIGINT", 130],
  ["cli", "SIGTERM", 143],
  ["cli", "SIGINT", 1],
] as const) {
  test(`${entry} ${signal} awaits group cleanup${code === 1 ? " and prints Cancelled on its first interrupt" : ""}`, options, async () => {
    await withFixture("wait", async (scope) => {
      const bridge = scope.launch(entry, entry === "cli" ? ["--json", "fixture"] : []);
      if (entry === "mcp") await initialize(bridge);
      const tree = await scope.ready();
      const started = Date.now();
      assert.equal(bridge.child.kill(signal), true);
      await until(() => scope.records().some((record) => record.kind === "term") && !exists(tree.leader), "task leader exit and resistant descendant");
      assert.equal(exists(tree.grandchild), true, "descendant must resist SIGTERM");
      assert.equal(bridge.exited, false, "bridge must stay alive to await cleanup, even with no task leader");
      await until(() => bridge.exited, `${entry} exit: ${bridge.stderr}`, 8_000);
      gone(tree);
      assert.ok(Date.now() - started >= 4_900, "bridge must keep the 5s escalation timer referenced");
      assert.equal(bridge.child.signalCode, null);
      assert.equal(bridge.child.exitCode, code, bridge.stderr);
      if (code === 1) {
        await until(() => bridge.child.stderr.readableEnded, "CLI stderr drain");
        assert.match(bridge.stderr, /^Cancelled$/m);
      }
    });
  });
}

test("CLI --help exits zero while its piped stdin remains open", options, async () => {
  await withFixture("wait", async (scope) => {
    const bridge = scope.launch("cli", ["--help"]);
    assert.equal(bridge.child.stdin.writableEnded, false);
    // Do not call stdin.end(): help must not try to read a prompt first.
    await until(() => bridge.exited, "--help with open stdin", 2_000);
    assert.equal(bridge.child.stdin.writableEnded, false);
    assert.equal(bridge.child.exitCode, 0, bridge.stderr);
    assert.equal(bridge.child.signalCode, null);
    await until(() => bridge.child.stderr.readableEnded, "help stderr drain");
    assert.match(bridge.stderr, /Usage: merc/);
    assert.deepEqual(scope.records(), [], "help must not launch opencode");
  });
});

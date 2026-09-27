#!/usr/bin/env node
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const role = process.argv[2] === "run" ? "leader" : process.argv[2];
const record = (entry) => appendFileSync(
  join(process.env.PROCESS_TEST_DIR, "processes.jsonl"),
  `${JSON.stringify({ role, pid: process.pid, ...entry })}\n`,
);
record({ kind: "start" });
setInterval(() => {}, 1_000);

if (role === "grandchild") {
  process.on("SIGTERM", () => record({ kind: "term" }));
  process.send({ grandchild: process.pid });
} else {
  // Inherit both the group and output pipes, including after the leader exits.
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), role === "leader" ? "middle" : "grandchild"], {
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  });
  child.on("error", (error) => { throw error; });
  child.once("message", (descendants) => {
    const tree = { ...descendants, [role]: process.pid };
    if (role === "middle") return process.send(tree);
    record({ kind: "ready", tree });
    process.stdout.write(`${JSON.stringify({
      type: "text", timestamp: Date.now(), sessionID: "ses_process_fixture",
      part: { type: "text", text: "Process tree ready" },
    })}\n`, () => {
      if (process.env.PROCESS_TEST_MODE === "normal") process.exit(0);
    });
  });
}

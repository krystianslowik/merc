#!/usr/bin/env node
// Fake opencode that never finishes and leaves a grandchild holding stdout, like a stuck tool shell.
import { spawn } from "node:child_process";
spawn("sleep", ["300"], { stdio: "inherit" });
console.log(JSON.stringify({ type: "step_start", timestamp: Date.now(), sessionID: "ses_fake", part: { type: "step-start" } }));
setInterval(() => {}, 1_000);

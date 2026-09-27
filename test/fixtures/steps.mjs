#!/usr/bin/env node
// Fake opencode that emits one bash step every STEP_MS, then a final answer.
const sessionID = "ses_steps";
const steps = Number(process.env.STEPS ?? 3);
const stepMs = Number(process.env.STEP_MS ?? 100);
const emit = (type, part) => console.log(JSON.stringify({ type, timestamp: Date.now(), sessionID, part }));
emit("step_start", { id: "s0", type: "step-start" });
for (let i = 1; i <= steps; i++) {
  await new Promise((r) => setTimeout(r, stepMs));
  emit("tool_use", { id: `t${i}`, type: "tool", tool: "bash", callID: `c${i}`, state: { status: "completed", input: { command: `echo ${i}` }, output: `${i}\n`, metadata: { exit: 0 } } });
}
emit("text", { id: "final", type: "text", text: "all steps done" });
emit("step_finish", { id: "f", type: "step-finish", reason: "stop", cost: 0.01, tokens: { input: 10, output: 5, reasoning: 0 } });

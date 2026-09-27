#!/usr/bin/env node
const args = process.argv.slice(2);
const mode = args.at(-1);
const event = JSON.stringify({
  type: "step_start", timestamp: Date.now(), sessionID: "ses_attach",
  part: { id: "start", type: "step-start" },
});
if (mode === "silent" || mode === "late") {
  if (mode === "late") process.once("SIGTERM", () => {
    process.stdout.write(`${event}\n`, () => process.exit(0));
  });
  setInterval(() => {}, 1_000);
  const url = args[args.indexOf("--attach") + 1];
  await fetch(`${url}/accepted`, { method: "POST" });
} else {
  console.log(event);
}

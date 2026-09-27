#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { resolve } from "node:path";
import * as z from "zod/v4";
import { formatTranscript } from "./format.ts";
import { DEFAULT_MODEL, DEFAULT_VARIANT, runTask } from "./opencode.ts";
import { cancelRun, startRun, waitRun } from "./runs.ts";

const server = new McpServer({ name: "opencode", version: "0.5.0" });

const taskInput = {
  prompt: z.string().min(1).describe("Complete, self-contained task description"),
  model: z.string().optional().describe(`provider/model, default ${DEFAULT_MODEL ?? "the model configured in opencode"}`),
  variant: z
    .string()
    .optional()
    .describe(`Reasoning effort, provider-specific (e.g. minimal, low, medium, high, max). Default ${DEFAULT_VARIANT ?? "the model's own"}`),
  agent: z.string().optional().describe("opencode agent name (e.g. build, plan)"),
  session: z.string().optional().describe("Session id from a previous result to continue that conversation"),
  cwd: z.string().optional().describe("Working directory, absolute or relative to the Claude Code project directory"),
};

function workdir(cwd?: string): string {
  return resolve(process.env.CLAUDE_PROJECT_DIR ?? process.cwd(), cwd ?? ".");
}

const text = (value: string, isError = false) => ({ content: [{ type: "text" as const, text: value }], isError });

server.registerTool(
  "task",
  {
    description:
      "Delegate a coding task to an opencode agent running on any provider/model (OpenRouter, local, etc). " +
      "The agent can read, edit and run commands in the working directory. Blocks until done, then returns a transcript " +
      "ending with its final answer and a session id. Pass that session id back to continue the same conversation. " +
      "For long tasks prefer start + wait, which shows progress as it happens.",
    inputSchema: z.object(taskInput),
  },
  async ({ prompt, model, variant, agent, session, cwd }, ctx) => {
    const dir = workdir(cwd);
    const result = await runTask({
      prompt,
      model,
      variant,
      agent,
      session,
      cwd: dir,
      attach: process.env.OPENCODE_SERVER_URL,
      // Esc in Claude Code cancels the request; stop opencode instead of letting it keep editing unseen.
      signal: ctx.mcpReq.signal,
    });
    return text(formatTranscript(result, dir), Boolean(result.error));
  },
);

server.registerTool(
  "start",
  {
    description:
      "Start an opencode task in the background and return its session id at once. Then call `wait` with that id " +
      "repeatedly until it reports done; each call returns the steps completed since the previous one.",
    inputSchema: z.object(taskInput),
  },
  async ({ prompt, model, variant, agent, session, cwd }) => {
    const started = await startRun({ prompt, model, variant, agent, session, cwd: workdir(cwd), attach: process.env.OPENCODE_SERVER_URL });
    if (started.final) return text(`id: ${started.id}\n\n${started.final}`, started.final.includes("\nFailed ("));
    return text(`id: ${started.id}\nRunning. Call wait with this id.`);
  },
);

server.registerTool(
  "wait",
  {
    description:
      "Wait for progress on a task from `start`. Returns the steps completed since the last call, after a few seconds " +
      "of batching (at most ~30s). The last line is `status: running` or `status: done`; keep calling while running. " +
      "When done, the result ends with a `=== FINAL ===` section holding the final answer and the cost footer.",
    inputSchema: z.object({ id: z.string().describe("id returned by start") }),
  },
  async ({ id }, ctx) => {
    const result = await waitRun(id, { signal: ctx.mcpReq.signal });
    return text(`${result.text}\n\nstatus: ${result.done ? "done" : "running"}`, result.isError);
  },
);

server.registerTool(
  "cancel",
  {
    description: "Cancel a running task from `start`: stops opencode and anything it started.",
    inputSchema: z.object({ id: z.string().describe("id returned by start") }),
  },
  async ({ id }) => text(cancelRun(id) ? `Cancelling ${id}. Call wait to collect the result.` : `No running task ${id}.`),
);

await server.connect(new StdioServerTransport());

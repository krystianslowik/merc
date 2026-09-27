import { relative } from "node:path";
import type { OpencodeEvent, Part, TaskResult, ToolState } from "./opencode.ts";

// Renders opencode events in the same visual language as a Claude Code transcript.

const TOOL_NAMES: Record<string, string> = {
  read: "Read",
  edit: "Update",
  write: "Write",
  patch: "Update",
  apply_patch: "Update",
  bash: "Bash",
  grep: "Search",
  glob: "Search",
  list: "List",
  webfetch: "Fetch",
  websearch: "Web Search",
  task: "Task",
  todowrite: "Update Todos",
  todoread: "Read Todos",
  skill: "Skill",
};

const MAX_RESULT_LINES = 6;

type ToolPart = Extract<Part, { type: "tool" }>;

function truncate(text: string, max: number): string {
  const oneLine = text.replace(/\s*\n\s*/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

function displayPath(path: unknown, cwd: string): string {
  if (typeof path !== "string") return "";
  const rel = relative(cwd, path);
  return rel && !rel.startsWith("..") ? rel : path;
}

function clipLines(lines: string[]): string[] {
  if (lines.length <= MAX_RESULT_LINES) return lines;
  return [...lines.slice(0, MAX_RESULT_LINES), `… +${lines.length - MAX_RESULT_LINES} lines`];
}

export function toolName(tool: string): string {
  if (TOOL_NAMES[tool]) return TOOL_NAMES[tool];
  // MCP tools arrive as "<server>_<tool>".
  return tool.charAt(0).toUpperCase() + tool.slice(1);
}

export function toolArgs(tool: string, input: Record<string, unknown> = {}, cwd: string): string {
  switch (tool) {
    case "read":
    case "edit":
    case "write":
      return displayPath(input.filePath, cwd);
    case "patch":
    case "apply_patch": {
      const files = [...String(input.patchText ?? input.patch ?? "").matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm)];
      return files.map((m) => displayPath(m[1].trim(), cwd)).join(", ");
    }
    case "bash":
      return truncate(String(input.command ?? ""), 100);
    case "grep":
      return `pattern: "${input.pattern}"${input.path ? `, path: "${displayPath(input.path, cwd)}"` : ""}`;
    case "glob":
      return `pattern: "${input.pattern}"`;
    case "list":
      return displayPath(input.path ?? cwd, cwd) || ".";
    case "webfetch":
      return String(input.url ?? "");
    case "task":
      return truncate(String(input.description ?? input.prompt ?? ""), 80);
    default: {
      const entries = Object.entries(input).map(([k, v]) => `${k}: ${JSON.stringify(v)}`);
      return truncate(entries.join(", "), 100);
    }
  }
}

function diffLines(diff: string): string[] {
  return diff
    .split("\n")
    .filter((l) => (l.startsWith("+") || l.startsWith("-")) && !l.startsWith("+++") && !l.startsWith("---"));
}

export function toolResult(tool: string, state: ToolState): string[] {
  if (state.status === "error") return [`Error: ${truncate(state.error ?? state.output ?? "failed", 300)}`];
  if (state.status !== "completed") return ["Running…"];

  const output = state.output ?? "";
  const meta = state.metadata ?? {};
  switch (tool) {
    case "read": {
      if (output.includes("<type>directory</type>")) return ["Listed directory"];
      const count = output.split("\n").filter((l) => /^\d+: /.test(l)).length;
      return [`Read ${count} line${count === 1 ? "" : "s"}`];
    }
    case "edit":
    case "patch":
    case "apply_patch": {
      const lines = typeof meta.diff === "string" ? diffLines(meta.diff) : [];
      if (!lines.length) return [truncate(output, 200) || "Updated"];
      const added = lines.filter((l) => l.startsWith("+")).length;
      return [`Updated with ${added} addition${added === 1 ? "" : "s"} and ${lines.length - added} removal${lines.length - added === 1 ? "" : "s"}`, ...clipLines(lines)];
    }
    case "skill":
      return [`Loaded skill ${String(state.input?.name ?? "")}`.trim()];
    case "write": {
      const content = (state.input?.content as string | undefined) ?? "";
      const count = content ? content.split("\n").length : 0;
      return [`Wrote ${count} line${count === 1 ? "" : "s"}`];
    }
    case "bash": {
      const exit = typeof meta.exit === "number" && meta.exit !== 0 ? [`Exit code ${meta.exit}`] : [];
      const lines = output.replace(/\n+$/, "").split("\n");
      return [...exit, ...(output.trim() ? clipLines(lines) : ["(No output)"])];
    }
    default: {
      const lines = output.replace(/\n+$/, "").split("\n");
      return lines[0] ? clipLines(lines.map((l) => truncate(l, 160))) : ["Done"];
    }
  }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Shortens absolute paths under cwd to relative ones, only where a path starts (not inside other paths). */
export function stripCwd(line: string, cwd: string): string {
  if (cwd === "/") return line;
  const prefix = cwd.endsWith("/") ? cwd : `${cwd}/`;
  return line.replace(new RegExp(`(^|[\\s"'(\`=:])${escapeRegExp(prefix)}`, "g"), "$1").replace(new RegExp(`^${escapeRegExp(prefix)}`, "gm"), "");
}

export function formatTool(part: ToolPart, cwd: string): string {
  const head = `● ${toolName(part.tool)}(${toolArgs(part.tool, part.state.input, cwd)})`;
  // Strip before toolResult truncates long lines, so paths keep their meaningful tail.
  const state = { ...part.state, output: part.state.output && stripCwd(part.state.output, cwd) };
  const [first, ...rest] = toolResult(part.tool, state).map((l) => stripCwd(l, cwd));
  return [head, `  ⎿  ${first}`, ...rest.map((l) => `     ${l}`)].join("\n");
}

export function formatText(text: string): string {
  const [first, ...rest] = text.trim().split("\n");
  return [`● ${first}`, ...rest.map((l) => (l ? `  ${l}` : l))].join("\n");
}

export function formatEvent(event: OpencodeEvent, cwd: string): string | undefined {
  const part = event.part;
  if (event.type === "error") return `● Error: ${event.error?.data?.message ?? event.error?.name}`;
  if (!part) return undefined;
  if (part.type === "tool") return formatTool(part as ToolPart, cwd);
  if (part.type === "text" && "text" in part && part.text.trim()) return formatText(part.text);
  return undefined;
}

export interface Summary {
  toolUses: number;
  tokens: number;
  cost: number;
}

export function summarize(events: OpencodeEvent[]): Summary {
  let toolUses = 0;
  let tokens = 0;
  let cost = 0;
  for (const { part } of events) {
    if (part?.type === "tool") toolUses++;
    if (part?.type === "step-finish" && ("cost" in part || "tokens" in part)) {
      cost += part.cost ?? 0;
      const t = part.tokens;
      tokens += (t?.input ?? 0) + (t?.output ?? 0) + (t?.reasoning ?? 0) + (t?.cache?.read ?? 0) + (t?.cache?.write ?? 0);
    }
  }
  return { toolUses, tokens, cost };
}

function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

export function formatFooter(result: TaskResult): string {
  const { toolUses, tokens, cost } = summarize(result.events);
  const subs = result.session;
  const stats = [
    `${toolUses} tool use${toolUses === 1 ? "" : "s"}`,
    `${formatTokens(tokens)} tokens`,
    subs?.subSessions
      ? `$${(cost + subs.subCost).toFixed(4)} incl. ${subs.subSessions} sub-agent${subs.subSessions === 1 ? "" : "s"}`
      : `$${cost.toFixed(4)}`,
    `${(result.durationMs / 1000).toFixed(1)}s`,
  ].join(" · ");
  const status = result.error ? "Failed" : "Done";
  return `${status} (${stats})\nopencode · ${result.session?.model ?? result.model ?? "default model"}${result.variant ? ` (${result.variant})` : ""} · session ${result.sessionID ?? "none"}`;
}

export function formatTranscript(result: TaskResult, cwd: string): string {
  const blocks = result.events.map((e) => formatEvent(e, cwd)).filter((b): b is string => Boolean(b));
  if (result.error && !result.events.some((e) => e.type === "error")) blocks.push(`● Error: ${result.error}`);
  // The relay agents hand back the last block as the answer, so make a missing answer explicit.
  const lastRendered = result.events.findLast((e) => formatEvent(e, cwd));
  if (!result.error && lastRendered?.part?.type !== "text") blocks.push("● (no final answer)");
  return [...blocks, "", formatFooter(result)].join("\n\n").replace(/\n{3,}/g, "\n\n");
}

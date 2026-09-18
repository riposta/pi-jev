/**
 * messages.ts — small, dependency-free helpers for reading Pi messages.
 *
 * Watchdog summaries are built locally from tool names, file paths and error
 * lines. No second LLM call is made to produce them (SDD 11.1). Router uses the
 * same helpers to keep a one-line memory of the previous turn.
 */

export interface SummarisedTurn {
  summary: string;
  tools_used: string[];
  errors: string[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Joins the text of a Pi message content field, ignoring images and tool calls. */
export function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!isObject(block)) continue;
    if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
  }
  return parts.join("\n");
}

/** Tool call names present in an assistant message. */
export function toolNamesFromMessage(message: unknown): string[] {
  if (!isObject(message)) return [];
  const content = message.content;
  if (!Array.isArray(content)) return [];
  const names: string[] = [];
  for (const block of content) {
    if (isObject(block) && block.type === "toolCall" && typeof block.name === "string") {
      names.push(block.name);
    }
  }
  return names;
}

/** File paths referenced by tool calls in an assistant message. */
export function pathsFromMessage(message: unknown): string[] {
  if (!isObject(message)) return [];
  const content = message.content;
  if (!Array.isArray(content)) return [];
  const paths: string[] = [];
  for (const block of content) {
    if (!isObject(block) || block.type !== "toolCall") continue;
    const args = block.arguments;
    if (!isObject(args)) continue;
    if (typeof args.path === "string") paths.push(args.path);
    if (typeof args.file_path === "string") paths.push(args.file_path);
  }
  return paths;
}

/** Error-looking lines from tool results, capped so the state stays small. */
export function errorLines(toolResults: unknown, max = 3): string[] {
  if (!Array.isArray(toolResults)) return [];
  const out: string[] = [];
  for (const result of toolResults) {
    if (!isObject(result) || result.isError !== true) continue;
    const text = contentText(result.content);
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      out.push(trimmed.slice(0, 200));
      if (out.length >= max) return out;
    }
  }
  return out;
}

export function firstLine(text: string, max = 140): string {
  const line = text.split("\n").find((candidate) => candidate.trim().length > 0)?.trim() ?? "";
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

/** Builds the compact turn record that watchdog sends as state. */
export function summariseTurn(message: unknown, toolResults: unknown): SummarisedTurn {
  const text = firstLine(contentText(isObject(message) ? message.content : ""));
  const tools = [...new Set(toolNamesFromMessage(message))];
  const errors = errorLines(toolResults);
  const parts: string[] = [];
  if (text) parts.push(text);
  if (tools.length > 0) parts.push(`tools: ${tools.join(", ")}`);
  if (errors.length > 0) parts.push(`errors: ${errors.join(" | ")}`);
  return { summary: parts.join(" — "), tools_used: tools, errors };
}

/** A guarded text extraction for arbitrary message-like values. */
export function messageText(message: unknown): string {
  if (typeof message === "string") return message;
  if (!isObject(message)) return "";
  return contentText(message.content);
}

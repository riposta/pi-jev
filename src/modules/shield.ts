/**
 * Module: shield.
 *
 * Hook: `tool_result`, sharing one request with prune (initial_plan.md §5.4). Replaces tool
 * output that carries instructions aimed at the model, and masks secrets and
 * personal data before they enter the context window or the session file.
 *
 * The ordering problem is explicit: content must reach Jev to be classified, so
 * shield cannot prevent the first exposure to TypeSafe. redact.ts runs first;
 * shield catches what patterns miss (initial_plan.md §10.3, 15.2).
 */

import type { Answers, Config, RedactFn, ShieldDecision } from "../types.ts";
import { FAILURE_TYPE_QUESTION, SHIELD_QUESTIONS } from "../questions.ts";

export type ShieldAnswers = Answers<typeof SHIELD_QUESTIONS & typeof FAILURE_TYPE_QUESTION>;

export function evaluateShield(answers: ShieldAnswers, config: Config): ShieldDecision {
  const cfg = config.modules.shield;
  const injection = answers.has_injection.noul;
  const secret = answers.has_secret.noul;
  const personalData = answers.has_personal_data.noul;
  const reasons: string[] = [];
  if (injection > cfg.injectionThreshold) reasons.push(`prompt injection (${injection.toFixed(2)})`);
  if (secret > cfg.secretThreshold) reasons.push(`secret (${secret.toFixed(2)})`);
  if (personalData > cfg.personalDataThreshold) reasons.push(`personal data (${personalData.toFixed(2)})`);
  const replace = injection > cfg.injectionThreshold;
  return { replace, reasons, injection, secret, personalData };
}

export function shieldHasMasking(decision: ShieldDecision): boolean {
  return !decision.replace && decision.reasons.length > 0;
}

/** Neutral notice that replaces withheld content. Names the tool and the reason. */
export function withheldNotice(tool: string, decision: ShieldDecision): string {
  return `Jev: output from "${tool}" was withheld (${decision.reasons.join(", ")}).`;
}

/**
 * Masks every text block of a tool result. Non-text blocks (images, files) are
 * passed through untouched rather than dropped: masking a secret in the prose
 * must not silently delete an attachment the agent still needs.
 */
export function maskContent(content: readonly unknown[], redact: RedactFn): unknown[] {
  const out: unknown[] = [];
  for (const block of content) {
    if (block && typeof block === "object" && (block as { type?: string }).type === "text") {
      const text = (block as { text?: string }).text ?? "";
      out.push({ type: "text", text: redact(text) });
    } else {
      out.push(block);
    }
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Sampling (initial_plan.md §10.1)                                                        */
/* -------------------------------------------------------------------------- */

export interface SampledOutput {
  text: string;
  totalLines: number;
  droppedLines: number;
}

export function sampleToolOutput(
  raw: string,
  head = 200,
  tail = 200,
  middle = 200,
): SampledOutput {
  const lines = raw.split("\n");
  const total = lines.length;
  if (total <= head + tail + middle) return { text: raw, totalLines: total, droppedLines: 0 };
  const headLines = lines.slice(0, head);
  const tailLines = lines.slice(-tail);
  const middleStart = Math.max(head, Math.floor(total / 2) - Math.floor(middle / 2));
  const middleLines = lines.slice(middleStart, middleStart + middle);
  const dropped = total - headLines.length - middleLines.length - tailLines.length;
  const text = [
    ...headLines,
    `… [pi-jev: dropped ${dropped} lines from the middle for classification] …`,
    ...middleLines,
    `… [pi-jev: dropped ${dropped} lines from the middle for classification] …`,
    ...tailLines,
  ].join("\n");
  return { text, totalLines: total, droppedLines: dropped };
}

/** Joins the text content of a tool result for classification. */
export function resultText(content: readonly unknown[], maxChars = 120_000): string {
  const parts: string[] = [];
  for (const block of content) {
    if (block && typeof block === "object" && (block as { type?: string }).type === "text") {
      parts.push((block as { text?: string }).text ?? "");
    }
  }
  return parts.join("\n").slice(0, maxChars);
}

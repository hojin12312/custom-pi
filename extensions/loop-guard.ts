/**
 * Exact Tool-Failure Loop Guard
 *
 * Stops a model from spending context on a deterministic cycle such as:
 *   same reasoning -> same edit(path, oldText, newText) -> same error -> repeat
 *
 * It intentionally uses exact SHA-256 fingerprints, not semantic similarity:
 * a guard only fires when the preceding assistant response, tool input, and
 * failed result are all unchanged.  The raw response, tool arguments, and
 * error text never enter the log.
 *
 * Policy:
 *   first deterministic failure: record it
 *   next identical attempted call: block and require a new strategy
 *   one more identical attempted call: block and terminate this tool batch
 *
 * By default only edit/write are covered.  These failures are deterministic
 * with an unchanged file, unlike many shell failures.  Set
 * PI_LOOP_GUARD_TOOLS=edit,write,bash to opt bash in.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import type { ExtensionAPI, ToolCallEvent, ToolResultEvent } from "@earendil-works/pi-coding-agent";

const LOG_FILE = "/tmp/pi-exact-loop-guard.log";
const GUARDED_TOOLS = new Set(
  (process.env.PI_LOOP_GUARD_TOOLS ?? "edit,write")
    .split(",")
    .map((tool) => tool.trim())
    .filter(Boolean),
);

type FailureRecord = {
  assistantHash: string;
  toolHash: string;
  errorHash: string;
  targetHash: string;
  attempts: number;
  toolName: string;
};

type Decision = "allow" | "block" | "terminate";

function log(level: "info" | "warn", message: string) {
  try {
    fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} [${level}] pid=${process.pid} ${message}\n`);
  } catch {
    // The guard must never affect an agent run merely because diagnostics fail.
  }
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`;
}

function hash(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function normalizedText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function assistantFingerprint(message: unknown): string {
  const content = (message as { content?: unknown })?.content;
  if (!Array.isArray(content)) return hash("");
  const text = content
    .filter((part): part is { type?: string; text?: string; thinking?: string } => Boolean(part && typeof part === "object"))
    .filter((part) => part.type === "text" || part.type === "thinking")
    .map((part) => part.text ?? part.thinking ?? "")
    .join("\n");
  return hash(normalizedText(text));
}

function toolFingerprint(event: Pick<ToolCallEvent | ToolResultEvent, "toolName" | "input">): string {
  return hash(`${event.toolName}:${stableJson(event.input)}`);
}

function errorFingerprint(event: ToolResultEvent): string {
  const text = event.content
    .filter((part): part is { type?: string; text?: string } => part.type === "text")
    .map((part) => part.text ?? "")
    .join("\n");
  return hash(normalizedText(text));
}

/**
 * A failed edit normally leaves its target untouched, but another process can
 * fix the file between model turns.  In that case the old retry may now be
 * valid, so discard the record instead of blocking it.
 */
function targetFingerprint(input: Record<string, unknown>): string {
  const path = input.path;
  if (typeof path !== "string" || !path) return "no-path";
  try {
    const stat = fs.statSync(path);
    if (!stat.isFile()) return `non-file:${stat.mtimeMs}:${stat.size}`;
    if (stat.size <= 8 * 1024 * 1024) return hash(fs.readFileSync(path, "utf8"));
    return `large-file:${stat.mtimeMs}:${stat.size}`;
  } catch (err) {
    return `unreadable:${(err as NodeJS.ErrnoException).code ?? "unknown"}`;
  }
}

export class ExactLoopTracker {
  private assistantHash = hash("");
  private failures = new Map<string, FailureRecord>();

  noteAssistant(message: unknown) {
    this.assistantHash = assistantFingerprint(message);
  }

  noteFailure(event: ToolResultEvent) {
    if (!event.isError || !GUARDED_TOOLS.has(event.toolName)) return;
    const toolHash = toolFingerprint(event);
    this.failures.set(toolHash, {
      assistantHash: this.assistantHash,
      toolHash,
      errorHash: errorFingerprint(event),
      targetHash: targetFingerprint(event.input),
      attempts: 1,
      toolName: event.toolName,
    });
  }

  noteSuccess(event: ToolResultEvent) {
    if (!GUARDED_TOOLS.has(event.toolName)) return;
    this.failures.delete(toolFingerprint(event));
  }

  inspectCall(event: ToolCallEvent): { decision: Decision; record?: FailureRecord } {
    if (!GUARDED_TOOLS.has(event.toolName)) return { decision: "allow" };
    const toolHash = toolFingerprint(event);
    const record = this.failures.get(toolHash);
    if (!record || record.assistantHash !== this.assistantHash) return { decision: "allow" };
    if (record.targetHash !== targetFingerprint(event.input)) {
      this.failures.delete(toolHash);
      return { decision: "allow" };
    }

    record.attempts += 1;
    return { decision: record.attempts >= 3 ? "terminate" : "block", record };
  }

  reset() {
    this.assistantHash = hash("");
    this.failures.clear();
  }

  status() {
    return [...this.failures.values()].map(({ toolName, attempts, errorHash }) => ({ toolName, attempts, errorHash }));
  }
}

export default function loopGuard(pi: ExtensionAPI) {
  const tracker = new ExactLoopTracker();
  log("info", `loaded tools=${[...GUARDED_TOOLS].join(",") || "(none)"}`);

  pi.on("input", (event) => {
    if (event.source !== "extension") tracker.reset();
  });

  pi.on("message_end", (event) => {
    const message = event.message as { role?: string };
    if (message.role === "assistant") tracker.noteAssistant(message);
  });

  pi.on("tool_result", (event) => {
    if (event.isError) tracker.noteFailure(event);
    else tracker.noteSuccess(event);
  });

  pi.on("tool_call", (event, ctx) => {
    const { decision, record } = tracker.inspectCall(event);
    if (decision === "allow" || !record) return;

    const suffix = decision === "terminate"
      ? "동일 호출이 차단된 뒤에도 반복되었습니다. 이 도구 배치를 종료합니다."
      : "대상 파일/전략을 다시 확인한 뒤 다른 도구 입력으로 진행하세요.";
    const reason = `[loop-guard] 동일 assistant 응답과 동일 ${record.toolName} 호출은 이미 같은 오류로 실패했습니다 (${record.errorHash}). ${suffix}`;
    log(decision === "terminate" ? "warn" : "info", `blocked tool=${record.toolName} attempts=${record.attempts} error=${record.errorHash} terminate=${decision === "terminate"}`);
    if (ctx.hasUI) ctx.ui.notify(`loop-guard: 동일 실패 반복 차단 (${record.toolName}, ${record.attempts}회)`, decision === "terminate" ? "warning" : "info");
    return { block: true, reason, terminate: decision === "terminate" };
  });

  pi.registerCommand("loop-status", {
    description: "Exact tool-failure loop guard 상태 확인",
    handler: async (_args, ctx) => {
      const records = tracker.status();
      const text = records.length === 0
        ? "loop-guard: 기록된 결정적 도구 실패 없음"
        : `loop-guard: ${records.map((r) => `${r.toolName} attempts=${r.attempts} error=${r.errorHash}`).join("; ")}`;
      if (ctx.hasUI) ctx.ui.notify(text, records.length ? "warning" : "info");
    },
  });
}

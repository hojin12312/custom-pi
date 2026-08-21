/**
 * Generation Loop Watchdog
 *
 * Detects exact periodic text/thinking degeneration while an assistant message
 * is still streaming, aborts that request, and resumes at most once after the
 * agent has fully settled. Tool-call argument deltas are intentionally ignored.
 * Only hashes and structural counts are written to the diagnostic log.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const LOG_FILE = "/tmp/pi-generation-loop-watchdog.log";
const ENABLED = process.env.PI_GENERATION_LOOP_GUARD !== "0";
const REPEAT_COUNT = integerEnv("PI_GENERATION_LOOP_REPEATS", 6, 4, 12);
const MIN_BLOCK_TOKENS = integerEnv("PI_GENERATION_LOOP_MIN_BLOCK_TOKENS", 8, 4, 64);
const MAX_BLOCK_TOKENS = integerEnv("PI_GENERATION_LOOP_MAX_BLOCK_TOKENS", 128, MIN_BLOCK_TOKENS, 256);
const MAX_RECOVERIES = integerEnv("PI_GENERATION_LOOP_MAX_RECOVERIES", 1, 0, 1);
const MIN_TOTAL_CHARS = 256;
const MIN_BLOCK_CHARS = 32;
const MIN_DISTINCT_WORDS = 4;
const CHECK_EVERY_CHARS = 48;
const MAX_WINDOW_CHARS = 16 * 1024;
const MAX_WINDOW_TOKENS = 1024;

type ChannelState = {
  raw: string;
  charsSinceCheck: number;
};

export type LoopDetection = {
  channel: string;
  blockTokens: number;
  blockChars: number;
  repeats: number;
  signature: string;
};

function integerEnv(name: string, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

function hash(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 16);
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

function tokenize(value: string): string[] {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .match(/[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu) ?? [];
}

function blockIsSubstantial(tokens: string[]): boolean {
  const compact = tokens.join(" ");
  if (compact.length < MIN_BLOCK_CHARS) return false;
  const words = tokens.filter((token) => /[\p{L}\p{N}_]/u.test(token));
  return new Set(words).size >= MIN_DISTINCT_WORDS;
}

function repeatedSuffix(tokens: string[], channel: string): LoopDetection | undefined {
  const available = Math.min(MAX_BLOCK_TOKENS, Math.floor(tokens.length / REPEAT_COUNT));
  for (let blockSize = MIN_BLOCK_TOKENS; blockSize <= available; blockSize++) {
    const blockStart = tokens.length - blockSize;
    const block = tokens.slice(blockStart);
    if (!blockIsSubstantial(block)) continue;

    let matches = true;
    for (let repetition = 2; repetition <= REPEAT_COUNT; repetition++) {
      const start = tokens.length - blockSize * repetition;
      for (let offset = 0; offset < blockSize; offset++) {
        if (tokens[start + offset] !== block[offset]) {
          matches = false;
          break;
        }
      }
      if (!matches) break;
    }
    if (!matches) continue;

    const normalized = block.join(" ");
    return {
      channel,
      blockTokens: blockSize,
      blockChars: normalized.length,
      repeats: REPEAT_COUNT,
      signature: hash(normalized),
    };
  }
  return undefined;
}

function log(level: "info" | "warn", message: string) {
  try {
    fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} [${level}] pid=${process.pid} ${message}\n`);
  } catch {
    // Diagnostics must never interfere with the agent run.
  }
}

export function turnFingerprint(message: unknown): string | undefined {
  const content = (message as { content?: unknown })?.content;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .filter((part): part is { type?: string; text?: string; thinking?: string } => Boolean(part && typeof part === "object"))
    .filter((part) => part.type === "text" || part.type === "thinking")
    .map((part) => part.text ?? part.thinking ?? "")
    .join("\n")
    .replace(/\s+/g, " ")
    .trim();
  const tools = content
    .filter((part): part is { type?: string; name?: string; arguments?: unknown } => Boolean(part && typeof part === "object"))
    .filter((part) => part.type === "toolCall")
    .map((part) => ({ name: part.name ?? "", arguments: part.arguments ?? null }));
  if (tools.length === 0) return undefined;
  return hash(`${text}\n${stableJson(tools)}`);
}

export class GenerationLoopTracker {
  private channels = new Map<string, ChannelState>();
  private triggered = false;

  startMessage() {
    this.channels.clear();
    this.triggered = false;
  }

  push(channel: string, delta: string): LoopDetection | undefined {
    if (this.triggered || !delta) return undefined;
    const state = this.channels.get(channel) ?? { raw: "", charsSinceCheck: 0 };
    state.raw += delta;
    state.charsSinceCheck += delta.length;
    if (state.raw.length > MAX_WINDOW_CHARS) state.raw = state.raw.slice(-MAX_WINDOW_CHARS);
    this.channels.set(channel, state);

    if (state.raw.length < MIN_TOTAL_CHARS || state.charsSinceCheck < CHECK_EVERY_CHARS) return undefined;
    state.charsSinceCheck = 0;
    const tokens = tokenize(state.raw).slice(-MAX_WINDOW_TOKENS);
    // Provider deltas may split a word at arbitrary byte/token boundaries
    // (for example `WATCH` + `DOG`). A check that lands mid-word would make
    // the incomplete suffix look unique and can repeatedly miss a genuinely
    // periodic stream. Ignore only that unstable trailing token; it will be
    // reconsidered after the next delta completes it.
    if (/[\p{L}\p{N}_]$/u.test(state.raw)) tokens.pop();
    const detection = repeatedSuffix(tokens, channel);
    if (detection) this.triggered = true;
    return detection;
  }
}

export default function generationLoopWatchdog(pi: ExtensionAPI) {
  const tracker = new GenerationLoopTracker();
  let pendingRecovery: LoopDetection | null = null;
  let recoveries = 0;
  let detections = 0;
  let lastDetection: LoopDetection | null = null;
  let lastTurnFingerprint: string | undefined;
  let repeatedTurns = 0;

  log(
    "info",
    `loaded enabled=${ENABLED} repeats=${REPEAT_COUNT} blockTokens=${MIN_BLOCK_TOKENS}-${MAX_BLOCK_TOKENS} maxRecoveries=${MAX_RECOVERIES}`,
  );

  pi.on("input", (event) => {
    if (event.source === "extension") return;
    tracker.startMessage();
    pendingRecovery = null;
    recoveries = 0;
    lastTurnFingerprint = undefined;
    repeatedTurns = 0;
  });

  pi.on("message_start", (event) => {
    const message = event.message as { role?: string };
    if (message.role === "assistant") tracker.startMessage();
  });

  pi.on("message_update", (event, ctx) => {
    if (!ENABLED || pendingRecovery) return;
    const update = event.assistantMessageEvent as {
      type?: string;
      contentIndex?: number;
      delta?: string;
    };
    if (update.type !== "text_delta" && update.type !== "thinking_delta") return;
    const detection = tracker.push(`${update.type}:${update.contentIndex ?? 0}`, update.delta ?? "");
    if (!detection) return;

    pendingRecovery = detection;
    lastDetection = detection;
    detections++;
    log(
      "warn",
      `detected channel=${detection.channel} blockTokens=${detection.blockTokens} blockChars=${detection.blockChars} repeats=${detection.repeats} signature=${detection.signature}`,
    );
    if (ctx.hasUI) ctx.ui.notify("generation-loop: 반복 생성 감지 → 현재 응답 중단", "warning");
    ctx.abort();
  });

  // Observe exact cross-turn assistant + tool-batch repetition without
  // blocking it yet. Identical polling can be legitimate; telemetry should
  // establish a safe policy before this becomes a hard guard.
  pi.on("turn_end", (event) => {
    const fingerprint = turnFingerprint(event.message);
    if (!fingerprint) {
      lastTurnFingerprint = undefined;
      repeatedTurns = 0;
      return;
    }
    if (fingerprint === lastTurnFingerprint) {
      repeatedTurns++;
      log("warn", `turn_repeat_observed count=${repeatedTurns + 1} signature=${fingerprint}`);
    } else {
      lastTurnFingerprint = fingerprint;
      repeatedTurns = 0;
    }
  });

  pi.on("agent_settled", async (_event, ctx) => {
    const detection = pendingRecovery;
    if (!detection) return;
    pendingRecovery = null;

    if (recoveries >= MAX_RECOVERIES) {
      log("warn", `recovery skipped: cap reached signature=${detection.signature}`);
      if (ctx.hasUI) ctx.ui.notify("generation-loop: 재개 응답도 반복됨 — 수동 확인 필요", "warning");
      return;
    }

    recoveries++;
    log("info", `recovery queued count=${recoveries}/${MAX_RECOVERIES} signature=${detection.signature}`);
    pi.sendUserMessage(
      "⚠️ (generation-loop watchdog) 이전 응답이 동일 문구를 반복 생성하여 자동 중단되었습니다. " +
        "마지막 사용자 요청과 현재 작업 상태를 다시 확인하고, 같은 문장이나 같은 도구 묶음을 반복하지 말고 다른 전략으로 계속 진행하세요.",
    );
    if (ctx.hasUI) ctx.ui.notify("generation-loop: 다른 전략으로 1회 자동 재개", "info");
  });

  pi.registerCommand("generation-loop-status", {
    description: "Generation loop watchdog 상태 확인",
    handler: async (_args, ctx) => {
      const detail = lastDetection
        ? `last=${lastDetection.signature} block=${lastDetection.blockTokens}x${lastDetection.repeats}`
        : "last=none";
      const text = `generation-loop: enabled=${ENABLED} detections=${detections} recoveries=${recoveries}/${MAX_RECOVERIES} repeatedTurns=${repeatedTurns + (lastTurnFingerprint ? 1 : 0)} ${detail}`;
      if (ctx.hasUI) ctx.ui.notify(text, detections ? "warning" : "info");
      log("info", `status ${text}`);
    },
  });
}

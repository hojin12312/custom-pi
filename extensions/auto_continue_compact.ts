import * as fs from "node:fs";
import type { ExtensionAPI, ExtensionContext, SessionCompactEvent } from "@earendil-works/pi-coding-agent";

/**
 * Smart Auto-Continue on Compaction Extension
 *
 * 2-Step Decision Gate Architecture:
 * 1. Upon context compaction (`session_compact`), requests a lightweight Step 1 decision prompt.
 * 2. If the LLM evaluates the previous output as `STATUS: TRUNCATED`, sends Step 2 clean resume prompt.
 * 3. If `STATUS: COMPLETED`, stops cleanly without unnecessary turns.
 *
 * ⚠️ Both sends are deferred to `agent_settled` (2026-08-20 fix). `session_compact`
 * and `agent_end` can both fire while the triggering run is still in progress
 * (mid-turn compaction; multi-continuation loops). pi.sendUserMessage() is
 * fire-and-forget from the extension's side — if the agent is still busy at
 * that exact instant, the send can lose a check-then-act race in pi core and
 * get rejected ("Agent is already processing a prompt"), which is silently
 * swallowed (only a generic runtime-error line, no retry). The prompt never
 * reaches the model and the task is left abandoned with no visible error.
 * (Root-caused live on a PICS session, 2026-08-20: both Step 1 and Step 2 hit
 * this exact race back to back.) `agent_settled` only fires once "no automatic
 * retry, compaction, or queued continuation will run" (pi's own doc comment)
 * — i.e. the one guaranteed-idle point — so sending from there closes the race
 * structurally instead of polling/waiting (which would deadlock: agent_end's
 * emit is awaited by the very run that would need to finish for idle to become
 * true).
 *
 * ⚠️ Step 1 (the decision prompt) can itself fail as a completion request —
 * not just get dropped by the race above, but error out (stopReason "error")
 * because the model backend was unavailable for an unrelated reason (e.g. a
 * PICS replica mid-restart while the request was already in flight — that
 * request can't be safely retried on another replica since a partial stream
 * had already gone out). Before 2026-08-20 this left the task permanently
 * stalled: the code only checked the reply text for "STATUS: TRUNCATED", so
 * an errored reply (no text) silently fell through as "nothing to do" and the
 * interrupted task was never resumed, with no visible indication anything was
 * wrong. (Caught live on a PICS session: `systemctl restart llamacpp@TP2x0`
 * killed an in-flight decision-prompt request; the extension gave up
 * silently and the session sat idle for over an hour before anyone noticed.)
 * Now: an errored decision-prompt reply is retried a bounded number of times,
 * and if retries are exhausted we resume anyway rather than stay stuck —
 * compaction having fired at all means something was likely cut off, so
 * failing to confirm should not mean giving up.
 */
export default function autoContinueCompactExtension(pi: ExtensionAPI) {
    const LOG_FILE = "/tmp/pi-auto-continue-compact.log";
    const MAX_DECISION_RETRIES = 2;

    function log(level: string, msg: string) {
        try {
            fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} [${level}] pid=${process.pid} ${msg}\n`);
        } catch {
            // logging failure is not worth interrupting the flow for
        }
    }

    let pendingDecision = false;
    let awaitingDecisionSend = false;
    let awaitingDecisionReply = false;
    let decisionRetryCount = 0;

    const decisionPrompt =
        `Inspect the last assistant message in the conversation above.\n\n` +
        `Determine if the response was:\n` +
        `1. COMPLETED: The assistant naturally finished its task, code, tool calls, or summary.\n` +
        `2. TRUNCATED: The response was cut off mid-output (e.g., unclosed code block, incomplete table, mid-sentence break, or missing final summary section).\n\n` +
        `Reply ONLY with one of these exact terms:\n` +
        `- STATUS: COMPLETED\n` +
        `- STATUS: TRUNCATED (reason: <brief 1-line reason>)`;

    const resumePrompt =
        `Notice: Your previous response was interrupted mid-task due to context token limits right before compaction.\n\n` +
        `Please resume and complete the interrupted task.\n\n` +
        `CRITICAL INSTRUCTIONS:\n` +
        `1. Clean Formatting: If a Markdown table or code block was cut off, cleanly re-render the table/code block with its full header/structure so the output is properly formatted.\n` +
        `2. No Floating Fragments: Do not output orphan table rows or raw code fragments without context.\n` +
        `3. Direct Execution: Skip conversational greetings and proceed directly to completing the remaining work.`;

    // agent_settled carries no message payload, so read the last assistant
    // message straight from session history (same approach as abnormal-stop-watchdog.ts).
    function lastAssistantMessage(ctx: ExtensionContext): any | null {
        let entries: Array<{ type: string; message?: any }> = [];
        try {
            entries = (ctx.sessionManager.getEntries() as Array<{ type: string; message?: any }>).filter(
                (e) => e.type === "message",
            );
        } catch {
            entries = [];
        }
        for (let i = entries.length - 1; i >= 0; i--) {
            const m = entries[i].message;
            if (m?.role === "assistant") return m;
        }
        return null;
    }

    function textOf(m: any | null): string {
        if (!m) return "";
        const content = m.content;
        if (typeof content === "string") return content;
        if (Array.isArray(content)) {
            return content
                .filter((c: any) => c.type === "text")
                .map((c: any) => c.text || "")
                .join("\n");
        }
        return "";
    }

    pi.on("session_compact", async (_event: SessionCompactEvent, ctx) => {
        // Avoid duplicate triggers if already in decision flow
        if (pendingDecision) return;

        // If the user already queued their own message, it will drive the
        // next turn — skip the auto decision prompt so it doesn't jump ahead
        // of (or pile onto) what the user already queued.
        if (ctx.hasPendingMessages()) return;

        pendingDecision = true;
        awaitingDecisionSend = true;
        // Actual send happens on the next agent_settled below — sending here
        // would race the still-in-progress run that triggered compaction.
    });

    pi.on("agent_settled", async (_event, ctx) => {
        if (awaitingDecisionSend) {
            awaitingDecisionSend = false;
            if (ctx.hasPendingMessages()) {
                pendingDecision = false;
                return;
            }
            // Send lightweight Step 1 decision prompt
            pi.sendUserMessage(decisionPrompt, { deliverAs: "followUp" });
            awaitingDecisionReply = true;
            decisionRetryCount = 0;
            // This settle belongs to the interrupted run, not the decision
            // prompt's own turn — its settle is the next one.
            return;
        }

        if (awaitingDecisionReply) {
            // Same guard as above: if the user queued a message while the
            // decision prompt was running, defer to that instead of injecting
            // our own resume prompt or retrying.
            if (ctx.hasPendingMessages()) {
                awaitingDecisionReply = false;
                pendingDecision = false;
                return;
            }

            const lastMsg = lastAssistantMessage(ctx);

            // The decision-prompt turn itself errored out (e.g. hit a model
            // backend that was mid-restart) — no verdict text to read. Retry
            // a bounded number of times before giving up.
            if (lastMsg?.stopReason === "error" && decisionRetryCount < MAX_DECISION_RETRIES) {
                decisionRetryCount++;
                log("warn", `decision prompt errored, retrying (${decisionRetryCount}/${MAX_DECISION_RETRIES})`);
                pi.sendUserMessage(decisionPrompt, { deliverAs: "followUp" });
                return; // stay in awaitingDecisionReply, wait for the retry's settle
            }

            awaitingDecisionReply = false;
            pendingDecision = false;

            if (lastMsg?.stopReason === "error") {
                // Retries exhausted with no verdict ever obtained. Compaction
                // firing at all means something was likely cut off, so treat
                // "couldn't confirm" as unsafe to leave stalled and resume
                // anyway rather than abandon the task silently.
                log("error", `decision prompt still erroring after ${MAX_DECISION_RETRIES} retries — resuming anyway`);
                pi.sendUserMessage(resumePrompt, { deliverAs: "followUp" });
                return;
            }

            // Check if decision is TRUNCATED
            if (textOf(lastMsg).includes("STATUS: TRUNCATED")) {
                // Step 2: Trigger clean task resume
                pi.sendUserMessage(resumePrompt, { deliverAs: "followUp" });
            }
        }
    });
}

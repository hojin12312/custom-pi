import type { ExtensionAPI, SessionCompactEvent } from "@earendil-works/pi-coding-agent";

/**
 * Smart Auto-Continue on Compaction Extension
 *
 * 2-Step Decision Gate Architecture:
 * 1. Upon context compaction (`session_compact`), sends a lightweight Step 1 decision prompt.
 * 2. If the LLM evaluates the previous output as `STATUS: TRUNCATED`, sends Step 2 clean resume prompt.
 * 3. If `STATUS: COMPLETED`, stops cleanly without unnecessary turns.
 */
export default function autoContinueCompactExtension(pi: ExtensionAPI) {
    let pendingDecision = false;

    pi.on("session_compact", async (event: SessionCompactEvent, ctx) => {
        // Avoid duplicate triggers if already in decision flow
        if (pendingDecision) return;

        // If the user already queued their own message, it will drive the
        // next turn — skip the auto decision prompt so it doesn't jump ahead
        // of (or pile onto) what the user already queued.
        if (ctx.hasPendingMessages()) return;

        pendingDecision = true;

        const decisionPrompt =
            `Inspect the last assistant message in the conversation above.\n\n` +
            `Determine if the response was:\n` +
            `1. COMPLETED: The assistant naturally finished its task, code, tool calls, or summary.\n` +
            `2. TRUNCATED: The response was cut off mid-output (e.g., unclosed code block, incomplete table, mid-sentence break, or missing final summary section).\n\n` +
            `Reply ONLY with one of these exact terms:\n` +
            `- STATUS: COMPLETED\n` +
            `- STATUS: TRUNCATED (reason: <brief 1-line reason>)`;

        // Send lightweight Step 1 decision prompt
        pi.sendUserMessage(decisionPrompt, { deliverAs: "followUp" });
    });

    pi.on("agent_end", async (event, ctx) => {
        if (!pendingDecision) return;

        // Reset flag for decision gate
        pendingDecision = false;

        // Same guard as above: if the user queued a message while the
        // decision prompt was running, defer to that instead of injecting
        // our own resume prompt.
        if (ctx.hasPendingMessages()) return;

        // Extract last assistant message text
        const messages = event.messages || [];
        const lastMsg = [...messages].reverse().find((m) => m.role === "assistant");

        if (!lastMsg) return;

        const textContent = typeof lastMsg.content === "string" 
            ? lastMsg.content 
            : Array.isArray(lastMsg.content)
                ? lastMsg.content.map((c: any) => c.text || "").join("\n")
                : "";

        // Check if decision is TRUNCATED
        if (textContent.includes("STATUS: TRUNCATED")) {
            const resumePrompt =
                `Notice: Your previous response was interrupted mid-task due to context token limits right before compaction.\n\n` +
                `Please resume and complete the interrupted task.\n\n` +
                `CRITICAL INSTRUCTIONS:\n` +
                `1. Clean Formatting: If a Markdown table or code block was cut off, cleanly re-render the table/code block with its full header/structure so the output is properly formatted.\n` +
                `2. No Floating Fragments: Do not output orphan table rows or raw code fragments without context.\n` +
                `3. Direct Execution: Skip conversational greetings and proceed directly to completing the remaining work.`;

            // Step 2: Trigger clean task resume
            pi.sendUserMessage(resumePrompt, { deliverAs: "followUp" });
        }
    });
}

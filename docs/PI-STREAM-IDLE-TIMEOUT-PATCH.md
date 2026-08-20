# 🧊 Stream Idle-Timeout Patch (local patch, pi-agent-core)

> **Status**: Applied to Mac Studio + MacBook Pro + PICS/simlab (all three, 2026-08-20) · Real-usage verification pending · Upstream PR decision pending
> **Versions**: `@earendil-works/pi-agent-core` 0.84.2 (bundled inside `@earendil-works/pi-coding-agent` 0.84.2)
> **Upstream repo**: [earendil-works/pi](https://github.com/earendil-works/pi)

---

## Symptom

A PICS/simlab pi session (interactive, tmux) froze mid-task: the TUI showed
`Thinking...` with **no further spinner motion, no output, no error** —
indefinitely. Live diagnosis on the hung process found:

- 0% CPU, 0 open TCP sockets, 0 child processes, every thread idle in
  `ep_poll`/`futex_do_wait` — not slow, not busy, **genuinely waiting on
  something that will never arrive**.
- The pics-token-proxy log showed the previous chat completion had already
  finished successfully (`elapsed=621.90s`, `output=23157` tokens, HTTP 200)
  — no new request had been sent since.
- The session's `.jsonl` log had a **complete, well-formed** last record: a
  full assistant message with an 85,314-char `thinking` block (token count
  matches the proxy's `output=23157`), but **`stopReason: null`**. The model's
  full response had already been received and persisted — the turn was just
  never marked as finished.

## Root cause (confirmed by code read, `pi-agent-core@0.84.2`)

`agent-loop.js`'s `streamAssistantResponse()` consumes the per-turn model
response as an `AssistantMessageEventStream` (from `@earendil-works/pi-ai`,
`utils/event-stream.js`):

```js
for await (const event of response) {
  switch (event.type) {
    ...
    case "done":
    case "error": {
      const finalMessage = await response.result();
      ...
      return finalMessage;
    }
  }
}
```

`EventStream`'s async iterator, when its internal queue is empty and it isn't
marked `done`, does:

```js
const result = await new Promise((resolve) => this.waiting.push(resolve));
```

That promise **only resolves when the producer calls `.push()` with an event
that satisfies `isComplete` (type `"done"`/`"error"`) or calls `.end()`
directly.** If the provider adapter that owns this stream reads the
underlying HTTP/SSE response and, on some path, stops delivering events
*without* ever pushing a terminal `"done"`/`"error"` event (e.g. the
connection closes without the exact terminal chunk the adapter's parser
expects), **nothing ever resolves that promise** — `for await` hangs forever,
`response.result()` (which awaits the same `finalResultPromise`) would also
hang if called, and the whole turn is stuck with no CPU/network activity to
observe, no exception to catch, and no `stopReason` ever set.

This is provider-agnostic in the sense that the defect is in the *consumer*
(`agent-loop.js`) never protecting itself against a stalled producer — this
is the single chokepoint all model turns pass through
(`Agent` → `runAgentLoop`/`runAgentLoopContinue` → `streamAssistantResponse`),
confirmed by grep: no other file in `pi-agent-core` calls `streamFunction`
or consumes its response.

The *exact* reason the specific provider stream stalled (PICS local proxy
chain: pi → `pics-token-proxy` (:8098) → SmartProxy (:8005) → llama.cpp) is
still open — this patch does not fix that adapter-level bug, it makes pi
survive it.

## Patch

**File**: `@earendil-works/pi-agent-core/dist/agent-loop.js`,
`streamAssistantResponse()`, the `for await (const event of response) { ... }`
loop.

Replaces the bare `for await` with manual iteration
(`response[Symbol.asyncIterator]().next()`) raced against an idle timer
(`PI_STREAM_IDLE_TIMEOUT_MS`, default 180000 / 3 min, env-overridable). On
timeout:

1. Synthesizes a `finalMessage` from whatever `partialMessage` content had
   already streamed in (no data loss — the model's partial thinking/text is
   preserved) with `stopReason: "error"` and an explanatory `error` string.
2. Calls `response.end(finalMessage)` so the `EventStream`'s
   `finalResultPromise` resolves too (defensive — nothing else in this
   codebase currently awaits it after a timeout, but this keeps the object
   internally consistent instead of leaving a permanently-dangling promise).
3. Emits `message_end` and returns, exactly like the existing `"error"` case
   — which means `runLoop()`'s existing `stopReason === "error"` handling
   (`turn_end` → `agent_end` → return) fires normally, and pi's existing
   auto-retry path (`AgentSession._isRetryableError` /
   `_handleRetryableError` / `auto_retry_start`/`auto_retry_end`) gets a
   chance to react to it like any other stream error, instead of the turn
   silently never ending.

Full diff: [`patches/agent-loop.stream-idle-timeout.patch`](../patches/agent-loop.stream-idle-timeout.patch).

- **Applied on** (all 2026-08-20, all `pi-agent-core` 0.84.2, original files confirmed byte-identical across machines before patching, patched output confirmed byte-identical after):
  - Mac Studio: `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js`
  - MacBook Pro: `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js` (reached via Tailscale IP `100.106.235.34` — the `mbp` SSH alias isn't configured on Studio; `node`/`pi` aren't on PATH in a non-interactive SSH shell either, use `/opt/homebrew/bin/node`)
  - PICS/simlab: `/usr/local/node-v22.21.0/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js`
- **Backup**: `agent-loop.js.bak-streamidletimeout-20260820` next to the patched file on each machine.
- **Loading**: this is a core dependency (not a pi extension), loaded once at
  process start via ESM import — **`/reload` does NOT pick this up**. Only a
  fresh `pi` process (new session / restart) runs the patched code. The
  session that was hung when this was written was left untouched (user
  chose diagnosis-only) and is still running the pre-patch code.
- **Config**: `PI_STREAM_IDLE_TIMEOUT_MS` (default `180000`) — minimum
  clamped to `5000`. 180s was chosen as a generous margin above observed
  legitimate single-turn durations on PICS (622s total turn time was normal;
  this is a *per-chunk idle* timeout, not a total-duration timeout, so it
  should not fire during a slow-but-actively-streaming response — only
  during a true stall). Raise it via env if a provider is known to have long
  legitimate gaps between chunks.

### Reapply after a package update (npm/homebrew reinstall overwrites the file)

```bash
# $F must resolve to .../node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js
F=<path-to>/@earendil-works/pi-agent-core/dist/agent-loop.js
cp "$F" "$F.bak-streamidletimeout-$(date +%Y%m%d)"
# -d must land in the node_modules/ that CONTAINS @earendil-works/ (three ../ up from dist/)
patch -p1 --dry-run -d "$(dirname "$F")/../../.." < patches/agent-loop.stream-idle-timeout.patch  # sanity check first
patch -p1 -d "$(dirname "$F")/../../.." < patches/agent-loop.stream-idle-timeout.patch
node --check "$F"
```

(Verified 2026-08-20: applying this to a clean copy of the pre-patch file reproduces the live patched file byte-for-byte.)

The patch is pinned to pi-agent-core 0.84.2's exact compiled output (like
the pi-subagents spinner fix, see `docs/PI-SUBAGENTS-SPINNER-FIX.md`). If
`patch` fails to apply after an upstream version bump, the surrounding code
likely changed — re-read `streamAssistantResponse()` in the new
`agent-loop.js` and re-derive the patch by hand rather than forcing it.

### Rollback

```bash
cp "$F.bak-streamidletimeout-20260820" "$F"
```

## Why this is the right layer

- Fixing the actual provider adapter (why did its SSE reader stop signalling
  completion) would be the deeper root-cause fix, but requires a live repro
  and touches provider-specific code (PICS was routing through a custom
  OpenAI-compatible proxy chain, not a stock provider) — not attempted here.
- Patching `agent-loop.js` instead is a single, provider-agnostic circuit
  breaker: **every** model call in pi funnels through this one function, so
  this protects against the same failure mode regardless of which provider
  or proxy chain eventually causes it.
- It reuses the *existing* error/stopReason contract
  (`stopReason: "error"` → `turn_end`/`agent_end` → auto-retry) instead of
  inventing a new recovery path, so it composes with whatever pi already
  does for genuine stream errors.

## Next steps (pending real-usage verification)

- [ ] Verify in real use: a deliberately stalled/blackholed provider now
      surfaces as an error + (if auto-retry is on) a retry, instead of a
      silent freeze.
- [ ] Investigate the actual PICS proxy-chain bug (pics-token-proxy /
      SmartProxy / opencode-go/OpenAI-compatible adapter in `pi-ai`) that
      caused the original stall, if reproducible.
- [x] Apply to MacBook Pro (2026-08-20 — reachable via Tailscale IP
      `100.106.235.34`; pi was installed there and actively in use, just not
      on PATH in a non-interactive SSH shell, which is why the first check
      missed it).
- [ ] On success, consider upstreaming to
      [earendil-works/pi](https://github.com/earendil-works/pi) — an
      idle-timeout on `streamAssistantResponse`'s consumption loop.

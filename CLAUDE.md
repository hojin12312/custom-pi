# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

`custom-pi` holds extensions, core-dependency patches, and sanitized config templates for [Pi Coding Agent](https://github.com/earendil-works/pi). It does **not** contain an app that gets built — the deliverable is a set of files that get copied onto each machine's real Pi installation. It is deployed identically on three independent git clones (see "Deployment topology" below), kept in sync by hand.

## Commands

**Install / redeploy after editing an extension:**
```bash
./install.sh
```
Copies `extensions/*.ts` → `~/.pi/agent/extensions/`, `scripts/*` → `~/.local/bin/`, and seeds `settings.json`/`models.json`/`web-search.json` from `config/*.example` **only if the real file doesn't already exist** (never overwrites live per-machine config). There is no build step — Pi loads/transpiles the `.ts` extension files directly at runtime.

For an already-running `pi` session to pick up an installed change: try `/reload` first (extensions hot-reload; this is the documented rollback path in `bg.ts`'s header). If the change touches state that's only initialized at process start, a full restart (`/exit` then relaunch, or `pi --session <id>` to resume the same session) is needed instead — extensions are loaded fresh only at process start.

**Tests:**
```bash
node --test tests/bg-redesign.test.mjs tests/loop-guard.test.mjs tests/generation-loop-watchdog.test.mjs
```
Node's `--test` needs explicit file paths here — a bare directory (`node --test tests/`) does not glob correctly in the Node version used on Studio.

**Quick syntax check on a single extension** (no local build/lint config exists; this is the ad hoc substitute):
```bash
bun build extensions/<file>.ts --target=node --outfile=/dev/null
```

## Deployment topology

Three independent clones of `github.com/hojin12312/custom-pi`, each with its own real (untracked) `~/.pi/agent/{settings,models,web-search}.json`:
- **Mac Studio** (control plane) — this checkout, `~/Projects/tools/custom-pi`.
- **MacBook Pro** — `~/Projects/tools/custom-pi` (reachable via `ssh mbp` or its Tailscale IP).
- **PICS/simlab** (Rocky Linux GPU inference server) — `~/custom-pi` (reachable via `ssh simlab`).

Redeploying a fix everywhere: commit + push from Studio, then on each of the other two machines `git pull --ff-only && bash install.sh`, then `/reload` (or restart) any already-running `pi` session there. Nothing automates this pull across machines.

## Architecture

### `extensions/` — Pi extension modules
Each file is a standalone default-exported `(pi: ExtensionAPI) => void` that wires up `pi.on(event, handler)`, `pi.registerCommand(...)`, and/or `pi.registerTool(...)`. Files are independent of each other; `install.sh` just copies all of them into Pi's extensions directory.

**The one architectural trap worth knowing before touching any extension that injects a follow-up turn** (`pi.sendUserMessage(...)`): the call is fire-and-forget from the extension's side — if the agent is still mid-run at that instant, the send loses a check-then-act race inside Pi core and is silently dropped (rejected with "Agent is already processing a prompt", surfaced only as a generic runtime-error line, never retried). `session_compact` and `agent_end` can both fire *while the triggering run is still active* (mid-turn compaction; multi-continuation loops), so sending directly from those handlers is racy. `agent_settled` is the only event that fires once a run has *truly* settled (Pi's own doc comment: "no automatic retry, compaction, or queued continuation will run") — defer sends there instead. Polling/waiting for `ctx.isIdle()` inside an `agent_end` handler will deadlock (that handler's own emit is awaited by the very run that needs to finish for idle to become true). See `auto_continue_compact.ts` for the reference implementation of this pattern, and `abnormal-stop-watchdog.ts` for a second extension that also injects follow-ups and should probably be audited the same way.

A second, separate failure mode for the same kind of extension: the *injected follow-up turn itself* can error out as a completion request (`stopReason === "error"`) — e.g. it happens to land on a PICS replica that's mid-restart, and the in-flight stream dies. If the handler only checks the reply's text content for a verdict, an errored reply (no text) silently reads as "nothing to do" and the original task stays stalled indefinitely with no visible error (caught live 2026-08-20: a `systemctl restart llamacpp@TP2x0` killed an in-flight `auto_continue_compact.ts` decision-prompt request; the session sat idle for over an hour before anyone noticed). `auto_continue_compact.ts` now checks `stopReason` and retries/falls back to resuming anyway — copy that pattern in any handler that reads a follow-up turn's reply.

Current extensions: `abnormal-stop-watchdog.ts` (detects a turn that ended `stop` with no tool calls and a stub response, gets an LLM judge verdict, auto-resumes), `generation-loop-watchdog.ts` (aborts exact text/thinking repetition during streaming and resumes at most once from `agent_settled`), `loop-guard.ts` (blocks exact repeated deterministic edit/write failures), `auto_continue_compact.ts` (detects truncation right after context compaction, auto-resumes; retries/falls back to resuming if the decision-prompt turn itself errors), `bg.ts` (background bash runner — `/bg`, `# bg:run` marker, `/bglist`, `/bgkill`, completion auto-injection; see its own header comment for the full design, it's been through several redesign phases), `core_commands.ts` (`/exit`, `/clear`), `imageread.ts` (routes images through a local VLM backend for text-only models), `question.ts` (interactive choice UI), `todo.ts` (3-state todo tool), `web_search_content.ts` (raw-content web search via Exa MCP).

`generation-loop-watchdog.ts` has two exact-period detection modes. `substantial` retains the original policy (a block with at least four distinct lexical tokens repeated six times). `low-diversity` covers degeneration such as `` `content` — `content` — … `` by requiring an exact period repeated at least 12 times across 256+ normalized characters and at least one lexical token of length two or more; punctuation-only separators remain allowed. Both `text_delta` and `thinking_delta` are covered, provider word-splitting is tolerated, and tool-call argument deltas remain excluded. A detection aborts the request, logs only hashes/structural counts plus `mode`, and queues one recovery from `agent_settled`; a second loop requires manual input. Use `/generation-loop-status` and `/tmp/pi-generation-loop-watchdog.log` for diagnosis, or `PI_GENERATION_LOOP_GUARD=0` for emergency disablement.

### `patches/` — patches to *installed* dependencies, not to this repo's code
Surgical patches applied directly to files inside `node_modules/@earendil-works/pi-agent-core/...` (and, per the pi-subagents entry in `README.md`, a separate patch to `node_modules/pi-subagents/...`) on each machine. These exist because the bug is in Pi's own core loop, not something an extension hook can intercept. Each patch is pinned to an exact upstream package version; a version bump silently overwrites the patched file, so it must be reapplied (reapply/rollback commands and root-cause writeups live in the matching `docs/*.md`, e.g. `docs/PI-STREAM-IDLE-TIMEOUT-PATCH.md`).

### `config/*.example` — sanitized templates only
The real `settings.json`/`models.json`/`web-search.json` live in `~/.pi/agent/` on each machine and are **not** in this repo (no secrets tracked here; `install.sh` seeds them from the `.example` files only on first install). In practice the real `models.json` on Studio and PICS is partly kept in sync by an external script, `pics-model-sync.py` (lives on the PICS host under `~/.local/bin/`, run via the `pi-update` shell function, **not** part of this repo) — it pulls each model's context window, output-token cap, and reasoning-effort enum from PICS's own SmartProxy `/admin/replicas` API and regenerates the `PICS` provider's model list. If a PICS-served model's config looks wrong in `models.json`, the fix usually belongs in that external sync script or in PICS's `sidecar-proxy/proxy.py` `MODEL_CONFIGS`, not in this repo's `config/models.json.example`.

## Codex / Gemini CLI configs detected

A global `~/.codex/config.toml` and a `~/.gemini` directory exist on this machine (unrelated to this repo). Reply `/import` to scan what's importable from them (MCP servers, slash commands, subagents, skills, instructions), then `/import --yes=<digest>` to apply.

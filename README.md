# 🥧 custom-pi

Custom extensions, core packages, and configuration templates for [Pi Coding Agent](https://github.com/earendil-works/pi).

> 🕒 **Last Updated**: 2026-08-20 (KST)

---

## 🎯 Core Pillars of Custom Pi

`custom-pi` is built around 3 core infrastructure pillars to empower Pi with web capabilities, autonomous subagents, and high-performance LLM gateway connectivity:

### 1. 🌐 Web Search & Content Fetching (`pi-web-access`)
* **Package**: `npm:pi-web-access`
* **Tools**: `web_search`, `fetch_content`, `get_search_content`
* **2-Tier Search Routing**: Built-in Exa → Brave fallback chain configured via `config/web-search.json.example`.
* **Curation**: Set `"workflow": "none"` to prevent browser timeout issues and ensure fast search results.

### 2. 🤖 Subagent Orchestration (`pi-subagents`)
* **Package**: `npm:pi-subagents`
* **Tools**: `subagent`, `subagent_wait`, `subagent_supervisor`, `intercom`
* **Multi-Agent Tasks**: Enables parent Pi sessions to spawn background subagent tasks with bi-directional supervisor communication via native intercom channels.
* ⚠️ **Local patch (2026-08-14, spinner fix; applied Studio·MBP 08-14, PICS/simlab 08-15)**: The async widget spinner froze / ran at ~1 fps during background runs — its 250 ms animation tick called `ctx.ui.requestRender?.()`, which does not exist on Pi's `ExtensionUIContext` (silent no-op), so the widget only repainted on job status changes (~1 s). Local patch applied to `~/.pi/agent/npm/node_modules/pi-subagents/src/runs/background/async-job-tracker.ts:542` (`requestLastWidgetRender()` → `rerenderLastWidget()`). **Re-apply after package updates** (PICS는 0.43.0→0.49.0 업그레이드 후 적용). Details & re-apply/rollback commands: [`docs/PI-SUBAGENTS-SPINNER-FIX.md`](docs/PI-SUBAGENTS-SPINNER-FIX.md).

### 3. 🌐 OpenCode Go Integration & Max Reasoning Effort
* **Gateway**: Connects Pi to OpenCode Zen Go Gateway (`opencode-go`) for unified access to DeepSeek V4, Kimi K3, GLM 5.2, MiniMax, Qwen 3.7 Max, Grok 4.5, etc.
* **DeepSeek Max Reasoning Effort**: DeepSeek 모델에 `thinkingLevelMap`(`reasoning: true`, `off`/`high`/`max`)을 `models.json`에 정의해 Pi TUI에서 Thinking Level을 고를 수 있게 한다. **2026-08-16 기준 배포 기본값은 `defaultThinkingLevel: "high"`** — 최대 추론이 필요하면 settings.json에서 `"max"`로 올린다. (구 "max 기본값" 서술은 현재 파일과 불일치 — OpenCode 안전 계약의 max 정책은 OpenCode CLI 쪽에만 남아 있음)
* 📖 See **[OpenCode Go Provider Integration Guide](docs/OPENCODE_GO_GUIDE.md)** for detailed setup.

---

## 🩹 Local Core Patches (`patches/`)

Surgical local patches to Pi's own core dependency packages (not custom-pi extensions) — applied directly to installed `node_modules`, documented and reapplied after upgrades.

* 🧊 **Stream idle-timeout (2026-08-20, applied Studio·MBP·PICS)**: `@earendil-works/pi-agent-core`'s `agent-loop.js` consumes each turn's model response via `for await` over an `EventStream`. If a provider adapter's SSE stream closes without ever pushing a terminal `"done"`/`"error"` event, that `for await` hangs forever with **0% CPU, 0 open sockets, no error** — the turn never gets a `stopReason`, the TUI freezes on `Thinking...` indefinitely (root-caused live on a hung PICS session: full response already received and persisted, but `stopReason: null`). Patch races each stream event against an idle timer (`PI_STREAM_IDLE_TIMEOUT_MS`, default 180s) and force-completes the turn with `stopReason: "error"` on timeout — preserves any partial content already streamed, feeds into pi's existing error/auto-retry path. Provider-agnostic (single chokepoint all model calls pass through). The fleet startup policy sets it to **600s** so a legitimate 200K-token cold prefill can finish; details, diff, and reapply/rollback commands: [`docs/PI-STREAM-IDLE-TIMEOUT-PATCH.md`](docs/PI-STREAM-IDLE-TIMEOUT-PATCH.md).
* ⚠️ **pi-subagents spinner fix (2026-08-14)** — see pillar 2 above and [`docs/PI-SUBAGENTS-SPINNER-FIX.md`](docs/PI-SUBAGENTS-SPINNER-FIX.md).

---

## 📋 Essential Custom Extensions (`extensions/`)

`custom-pi` includes essential developer productivity tools:

* 🚪 **`core_commands.ts` (Extra Slash Commands)**: Adds `/exit` (graceful Pi shutdown, same as `/quit` via `ctx.shutdown()`) and `/clear` (start a new session, same as `/new` via `ctx.newSession()`). Implemented as an extension so it survives Pi updates.
* 🕐 **`bg.ts` (Bash Background Runner)**: Long-running bash commands (downloads, builds) can be pushed to the background so the agent keeps working on other tasks.
  * **🏗 Redesigned (2026-08-20, [plan](docs/BG-REDESIGN-PLAN.md))** — backgrounding is now **explicit at start** and wrapper/tail-free: the extension `spawn()`s a detached bash (own process group) directly, logging to `/tmp/pi-bg/<jobid>/log`. No wrapper script, no `tail -f` → no orphan tails, no pipe pollution, no `pkill` self-recursion, and **zero overhead for ordinary commands** (they pass through unwrapped).
    * **`/bg <command>`** (user) — runs the command in the background and returns immediately; completion is auto-injected (below). `/bg`·`/bglist`·`/bgkill` are always registered.
    * **`# bg:run` marker** (agent, G8) — models cannot type slash commands, so appending `# bg:run` to a Bash tool command rewrites the call to `spawnBackground()`: the tool call returns immediately with `[bg] started in background job=<id>`, and the completion notice closes the loop with **zero user intervention**. `# bg:quiet` combines with it.
    * **`ctrl+q`** — shows status of running `/bg` jobs (pid + last 10 log lines); with no jobs it hints to use `/bg`. (The old "send the running foreground command to background" mid-execution transition is retired — background at start instead.)
    * **`bgnow {list|status <id>|kill <id>}`** — query/kill jobs from outside Pi (tmux panels). Legacy `bgnow [jobid]` transition calls print a deprecation notice and fall back to status.
  * **Auto-injected completion notice (2026-08-12, replaces `[bg notice]`)** — jobs started with `/bg`/`# bg:run` are announced when they finish. Completion is detected event-driven (`fs.watch` on `/tmp/pi-bg` + a 5s fallback sweep gated to relevant jobs; Linux uses polling only — `FSWatcher.unref()` is ineffective on Node 22) and injected into the agent's **message queue** via `pi.sendMessage` (`customType: 'bg-complete'`, `deliverAs: 'followUp'` + `triggerTurn: true`): if the agent is idle the turn fires immediately, if user commands are queued it waits behind them. Concurrent completions are batched (1.5s debounce) into one message. The notice template marks the log as data, not instructions (prompt-injection guard). Other Pi sessions never receive notices; each job is announced once (`notified` marker). Add `# bg:quiet` to a command to skip its completion notice.
  * **`/bglist` / `/bgkill <id|all>`** — current-session background job status (`⏳ running [bg]`, `✓ done`, `✗ failed`, `💀 gone`) and process-group kill (SIGTERM → 2s → SIGKILL, PGID-based with legacy-job fallback).
  * **Notes**: Every job records the owning Pi session ID and an explicit `backgrounded` marker; legacy records without these fields are ignored. The command is written to a file and `eval`'d in a subshell (multi-line safe; `exit N` in the command still records the exit code). Rollback: `git revert` (legacy wrapper code removed in Phase 3) or remove the file + `/reload` (running jobs keep going, notices stop). Tests: `tests/bg-redesign.test.mjs` (PGID isolation, group kill, exit codes, multi-line cmds, auto-inject, quiet, unwrapped passthrough, no orphan tail).
  * **🛠 `pi -p` exit-hang fix (2026-08-15, applied Studio·MBP·PICS)**: the extension's `fs.watch` + sweep timer kept the event loop alive, so one-shot `pi -p` never exited after answering. Fixed by `unref()`-ing the watcher and sweep timer, and — because **`FSWatcher.unref()` is ineffective on Linux/Node 22** (verified 2026-08-15) — **skipping `fs.watch` on Linux entirely** and relying on the unref'd 5s polling sweep for completion detection (instant → ≤5s). macOS keeps the instant `fs.watch`. Note: `pi -p` also blocks when stdin stays open (all platforms) — pipe `</dev/null` for automation/ssh.
* 🔍 **`web_search_content.ts` (OpenCode-style Raw Web Search)**: Port of OpenCode's built-in `websearch` tool (Exa MCP `web_search_exa`). Returns **RAW page content** (up to 10k chars/result, `livecrawl: fallback` for fresh pages) instead of a synthesized answer — the model reads sources and answers directly with exact details. **Usage split vs `web_search` (pi-web-access)**: `web_search_content` = quick factual lookups needing ground truth (versions, params, errors, code); `web_search` = broad multi-query research / synthesized overviews; `fetch_content` = fetching a known URL. Compact one-line TUI rendering. Uses `EXA_API_KEY` env (falls back to keyless Exa MCP free tier).
* 🔄 **`auto_continue_compact.ts` (Smart Auto-Continue on Compaction)**:
  * **2-Step Decision Gate**: Automatically detects context compaction (`session_compact`) and prompts the model to evaluate if output was cut off mid-task (`STATUS: TRUNCATED`).
  * **Seamless Task Resume**: Automatically sends a clean follow-up prompt to re-render broken tables/code blocks and resume interrupted tasks without manual intervention.
  * **⚠️ Pending-queue guard (2026-08-20, applied Studio·MBP·PICS)**: If the user already queued their own follow-up message before/during compaction, the Step 1 decision prompt and Step 2 resume prompt are skipped (`ctx.hasPendingMessages()` check in both `session_compact` and `agent_end`) — the queued user message already drives the next turn, so injecting an auto prompt on top would jump ahead of (or pile onto) it.
* 🛡️ **`abnormal-stop-watchdog.ts` (Abnormal Stop Watchdog)** — detects when the agent stops mid-task and resumes it:
  * **Premature-stop detection**: A turn that ends with `stopReason: stop`, **no tool calls**, and a stub response (empty text, a bare checklist item like `6. …`, or short text without any closing summary) right after tool activity is flagged as a possible mid-task stop.
  * **LLM verdict gate**: Before acting, a cheap local judge call classifies the last response as `COMPLETE` / `INCOMPLETE` (default endpoint `PI_WD_JUDGE_URL` → `http://127.0.0.1:8104/v1/chat/completions`, model `PI_WD_JUDGE_MODEL` → `deepseek-v4-flash`; reasoning disabled via `reasoning_effort: none`).
  * **Auto-resume**: On `INCOMPLETE`, injects a "continue from where you stopped" user message via `pi.sendUserMessage` — capped at `PI_WD_MAX_RESUMES` (default 2) per user prompt, with duplicate-turn protection.
  * **Guardrail**: Appends a "never end mid-task" rule to the system prompt on every turn (`before_agent_start`).
  * **Observability**: `/wd-status` command + event log at `/tmp/pi-abnormal-stop-watchdog.log`.
* 🔁 **`loop-guard.ts` (Exact Tool-Failure Loop Guard, 2026-08-20)** — prevents a deterministic agent loop before it consumes another full model turn. It records only hashes of the preceding assistant response, tool input, and tool error; when all three repeat for an `edit` or `write` call, it blocks the duplicate and tells the model to re-read the target or choose another strategy. A third identical attempt terminates that tool batch. Normal retries reset on a changed response/input, a successful mutation, or a new user prompt. `/loop-status` shows hash-only state. `bash` is deliberately excluded by default because transient shell failures may merit a retry; opt in with `PI_LOOP_GUARD_TOOLS=edit,write,bash`.
* 👁️ **`imageread.ts` (Local VLM Vision Bridge)**:
  * **Why it's needed**: High-performance coding models like DeepSeek V4 Flash or DeepSeek R1 are text-only models (`input: ["text"]`). `imageread` bridges this gap by allowing text models to inspect screenshots, charts, and image files via a local VLM endpoint.
  * **Dynamic Tool Activation**: Automatically activates when a text-only model is selected and hides itself when a native vision model (e.g. GPT-4o) is active.
  * **Smart High-Res Tiling & Normalized Crop**: Supports `detail=low` (~1MP overview), `crop` (normalized 0-1000 zoom-in for small text/code), and `detail=high` (tiled full-resolution reading).
  * **Configurable VLM Backend**: Configured via environment variables (`IMAGEREAD_VLM_URL`, `IMAGEREAD_VLM_MODEL`), using **Qwen3.8 27B** (2026-08-17~, 이전 Qwen3.6 35B A3B) served by a local VLM backend (`localhost:8098` via token proxy; token stats logged by the proxy). Remote hosts point `IMAGEREAD_VLM_URL` at their own backend address. Auth key in `IMAGEREAD_VLM_API_KEY`.
* 📝 **`todo.ts` (Essential Task Tracker)**:
  * **3-State Task Status**: Tracks task states (`pending`, `in_progress`, `completed`).
  * **`/todos` Command**: Slash command to inspect active task lists during sessions.
  * **Real-time Terminal UI**: Live progress indicators (`X/Y completed`) in the Pi terminal UI.
* ❓ **`question.ts` (Interactive Prompts)**: Interactive multi-choice and write-in question modal UI.

---

## ⚙️ Configuration Templates

Sanitized configuration templates in `config/`:

* **`config/settings.json.example`**: Pre-configured with `defaultProvider: "deepseek"`, `defaultThinkingLevel: "max"`, compaction reserves (`reserveTokens: 49152`, `keepRecentTokens: 20000`), and default packages.
* **`config/models.json.example`**: Complete provider schemas for direct Cloud APIs (DeepSeek Official, OpenAI) & OpenCode Go gateway.
* **`config/web-search.json.example`**: 2-tier search routing (Exa → Brave) template.

---

## 📥 Quick Start & Installation

Clone the repository and run `install.sh`:

```bash
git clone https://github.com/hojin12312/custom-pi.git
cd custom-pi
./install.sh
```

---

## 🔒 Privacy & Security

No private API keys, IP addresses, or secrets are tracked in this repository. Update `settings.json`, `models.json`, and `web-search.json` with your credentials after installation.

---

## 🙏 Credits & Acknowledgements

* **[Pi Coding Agent](https://github.com/earendil-works/pi)**: Core terminal coding agent created by Mario Zechner & Earendil Works.
* **[pi-subagents](https://www.npmjs.com/package/pi-subagents) & [pi-web-access](https://www.npmjs.com/package/pi-web-access)**: Official subagent orchestration and web search extension packages for Pi.

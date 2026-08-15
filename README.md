# 🥧 custom-pi

Custom extensions, core packages, and configuration templates for [Pi Coding Agent](https://github.com/earendil-works/pi).

> 🕒 **Last Updated**: 2026-08-08 02:12:38 (KST)

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

### 3. 🌐 OpenCode Go Integration & Max Reasoning Effort
* **Gateway**: Connects Pi to OpenCode Zen Go Gateway (`opencode-go`) for unified access to DeepSeek V4, Kimi K3, GLM 5.2, MiniMax, Qwen 3.7 Max, Grok 4.5, etc.
* **DeepSeek Max Reasoning Effort**: Configures DeepSeek models with `defaultThinkingLevel: "max"` in `settings.json` and custom `thinkingLevelMap` in `models.json` for maximum reasoning depth during complex coding.
* 📖 See **[OpenCode Go Provider Integration Guide](docs/OPENCODE_GO_GUIDE.md)** for detailed setup.

---

## 📋 Essential Custom Extensions (`extensions/`)

`custom-pi` includes essential developer productivity tools:

* 🚪 **`core_commands.ts` (Extra Slash Commands)**: Adds `/exit` (graceful Pi shutdown, same as `/quit` via `ctx.shutdown()`) and `/clear` (start a new session, same as `/new` via `ctx.newSession()`). Implemented as an extension so it survives Pi updates.
* 🕐 **`bg.ts` (Bash Background Runner)**: Long-running bash commands (downloads, builds) can be pushed to the background so the agent keeps working on other tasks.
  * **`ctrl+q` during a tool run** — moves the running command owned by the **current Pi session** to background: the tool call returns immediately with a `[bg] moved to background` notice, and the agent continues its turn while the job keeps running (output → `/tmp/pi-bg/<jobid>/log`). Also available outside Pi via `bgnow [jobid]`; when multiple sessions have foreground jobs, `bgnow` requires an explicit job ID.
  * **Auto-injected completion notice (2026-08-12, replaces `[bg notice]`)** — only jobs explicitly moved with `ctrl+q`/`bgnow` are announced when they finish. Completion is detected event-driven (`fs.watch` on `/tmp/pi-bg` + a 5s fallback sweep gated to relevant jobs) and injected into the agent's **message queue** via `pi.sendMessage` (`customType: 'bg-complete'`, `deliverAs: 'followUp'` + `triggerTurn: true`): if the agent is idle the turn fires immediately, if user commands are queued it waits behind them. Concurrent completions are batched (1.5s debounce) into one message. The notice template marks the log as data, not instructions (prompt-injection guard). Ordinary foreground Bash calls and other Pi sessions never receive notices; each job is announced once (`notified` marker). Add `# bg:quiet` to a command to skip its completion notice.
  * **`/bglist` / `/bgkill <id|all>`** — current-session background job status (`⏳ running [bg]`, `✓ done`, `✗ failed`, `💀 gone`) and process-group kill (SIGTERM → SIGKILL).
  * **Notes**: Every LLM Bash call is provisionally wrapped so `ctrl+q` remains available, but normal foreground completion removes its temporary metadata. Each transitioned job records both the Pi session ID and an explicit `backgrounded` marker; legacy global records without these fields are ignored. `# bg:off` opts out of wrapping. Slash-command input is queued while a tool runs, so `ctrl+q` is the primary path. `/bg`·`/bglist`·`/bgkill` are exposed after a current-session job is backgrounded (Pi has no command-unregister API, so registration lasts until `/reload`). Rollback: remove the file + `/reload`.
* 🔍 **`web_search_content.ts` (OpenCode-style Raw Web Search)**: Port of OpenCode's built-in `websearch` tool (Exa MCP `web_search_exa`). Returns **RAW page content** (up to 10k chars/result, `livecrawl: fallback` for fresh pages) instead of a synthesized answer — the model reads sources and answers directly with exact details. **Usage split vs `web_search` (pi-web-access)**: `web_search_content` = quick factual lookups needing ground truth (versions, params, errors, code); `web_search` = broad multi-query research / synthesized overviews; `fetch_content` = fetching a known URL. Compact one-line TUI rendering. Uses `EXA_API_KEY` env (falls back to keyless Exa MCP free tier).
* 🔄 **`auto_continue_compact.ts` (Smart Auto-Continue on Compaction)**:
  * **2-Step Decision Gate**: Automatically detects context compaction (`session_compact`) and prompts the model to evaluate if output was cut off mid-task (`STATUS: TRUNCATED`).
  * **Seamless Task Resume**: Automatically sends a clean follow-up prompt to re-render broken tables/code blocks and resume interrupted tasks without manual intervention.
* 🛡️ **`abnormal-stop-watchdog.ts` (Abnormal Stop Watchdog)** — detects when the agent stops mid-task and resumes it:
  * **Premature-stop detection**: A turn that ends with `stopReason: stop`, **no tool calls**, and a stub response (empty text, a bare checklist item like `6. …`, or short text without any closing summary) right after tool activity is flagged as a possible mid-task stop.
  * **LLM verdict gate**: Before acting, a cheap local judge call classifies the last response as `COMPLETE` / `INCOMPLETE` (default endpoint `PI_WD_JUDGE_URL` → `http://127.0.0.1:8104/v1/chat/completions`, model `PI_WD_JUDGE_MODEL` → `deepseek-v4-flash`; reasoning disabled via `reasoning_effort: none`).
  * **Auto-resume**: On `INCOMPLETE`, injects a "continue from where you stopped" user message via `pi.sendUserMessage` — capped at `PI_WD_MAX_RESUMES` (default 2) per user prompt, with duplicate-turn protection.
  * **Guardrail**: Appends a "never end mid-task" rule to the system prompt on every turn (`before_agent_start`).
  * **Observability**: `/wd-status` command + event log at `/tmp/pi-abnormal-stop-watchdog.log`.
* 👁️ **`imageread.ts` (Local VLM Vision Bridge)**:
  * **Why it's needed**: High-performance coding models like DeepSeek V4 Flash or DeepSeek R1 are text-only models (`input: ["text"]`). `imageread` bridges this gap by allowing text models to inspect screenshots, charts, and image files via a local VLM endpoint.
  * **Dynamic Tool Activation**: Automatically activates when a text-only model is selected and hides itself when a native vision model (e.g. GPT-4o) is active.
  * **Smart High-Res Tiling & Normalized Crop**: Supports `detail=low` (~1MP overview), `crop` (normalized 0-1000 zoom-in for small text/code), and `detail=high` (tiled full-resolution reading).
  * **Configurable VLM Backend**: Configured via environment variables (`IMAGEREAD_VLM_URL`, `IMAGEREAD_VLM_MODEL`), using **Qwen3.6 35B A3B** served by a local VLM backend (`localhost:8098` via token proxy; token stats logged by the proxy). Remote hosts point `IMAGEREAD_VLM_URL` at their own backend address. Auth key in `IMAGEREAD_VLM_API_KEY`.
* 📝 **`todo.ts` (Essential Task Tracker)**:
  * **3-State Task Status**: Tracks task states (`pending`, `in_progress`, `completed`).
  * **`/todos` Command**: Slash command to inspect active task lists during sessions.
  * **Real-time Terminal UI**: Live progress indicators (`X/Y completed`) in the Pi terminal UI.
* ❓ **`question.ts` (Interactive Prompts)**:  Interactive multi-choice and write-in question modal UI.

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
* **[OpenCode](https://github.com/anomalyco/opencode)**: Original tool concepts and algorithms adapted for Pi extensions (`imageread`).

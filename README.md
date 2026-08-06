# 🥧 custom-pi

Custom extensions, core packages, and configuration templates for [Pi Coding Agent](https://github.com/earendil-works/pi).

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

* 👁️ **`imageread.ts` (Local VLM Vision Bridge)**:
  * **Why it's needed**: High-performance coding models like DeepSeek V4 Flash or DeepSeek R1 are text-only models (`input: ["text"]`). `imageread` bridges this gap by allowing text models to inspect screenshots, charts, and image files via a local VLM endpoint.
  * **Dynamic Tool Activation**: Automatically activates when a text-only model is selected and hides itself when a native vision model (e.g. GPT-4o) is active.
  * **Smart High-Res Tiling & Normalized Crop**: Supports `detail=low` (~1MP overview), `crop` (normalized 0-1000 zoom-in for small text/code), and `detail=high` (tiled full-resolution reading).
  * **Configurable VLM Backend**: Configured via environment variables (`IMAGEREAD_VLM_URL`, `IMAGEREAD_VLM_MODEL`). Recommended local vision models include Qwen2.5-VL / Qwen3.5-VL (3B / 7B / 35B A3B), InternVL 2.5/3.0 (2B / 4B / 8B), or SmolVLM (2.2B).
* 📝 **`todo.ts` (Essential Task Tracker)**:
  * **3-State Task Status**: Tracks task states (`pending`, `in_progress`, `completed`).
  * **`/todos` Command**: Slash command to inspect active task lists during sessions.
  * **Real-time Terminal UI**: Live progress indicators (`X/Y completed`) in the Pi terminal UI.
* 🛠️ **`apply_patch.ts` (Multi-file Patching)**: Multi-file Git-style chunk patch tool (`*** Begin Patch ...`). Supports file creation, edits, movement, and deletions in a single tool call.
* ❓ **`question.ts` (Interactive Prompts)**: Interactive multi-choice and write-in question modal UI.

---

## ⚙️ Configuration Templates

Sanitized configuration templates in `config/`:

* **`config/settings.json.example`**: Pre-configured with `defaultProvider: "deepseek"`, `defaultThinkingLevel: "max"`, token reserve, and default packages.
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
* **[OpenCode](https://github.com/anomalyco/opencode)**: Original tool concepts and algorithms adapted for Pi extensions (`apply_patch`, `imageread`).

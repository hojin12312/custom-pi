# 🥧 custom-pi

Custom extensions, core packages, and configuration templates for [Pi Coding Agent](https://github.com/earendil-works/pi).

---

## 🎯 Core Pillars of Custom Pi

`custom-pi` is built around 3 core pillars to empower Pi with web capabilities, autonomous subagents, and high-performance LLM gateway connectivity:

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
* **Gateway**: Connects Pi to OpenCode Zen Go Gateway (`opencode-go-proxy`) for unified access to DeepSeek V4, Kimi K3, GLM 5.2, MiniMax, Qwen 3.7 Max, Grok 4.5, etc.
* **DeepSeek Max Reasoning Effort**: Configures DeepSeek models with `defaultThinkingLevel: "max"` in `settings.json` and custom `thinkingLevelMap` in `models.json` for maximum reasoning depth during complex coding.
* 📖 See **[OpenCode Go Provider Integration Guide](docs/OPENCODE_GO_GUIDE.md)** for detailed setup.

---

## 🛠️ Included Custom Extensions (`extensions/`)

* **`apply_patch.ts`**: Multi-file Git-style chunk patch tool (`*** Begin Patch ...`). Supports add, update, move, and delete in a single tool call.
* **`imageread.ts`**: Local VLM vision integration for text-only coding models. Supports low/high detail reading, tiling, and normalized crop zoom-ins.
* **`todo.ts`**: Interactive 3-state task list (`pending`, `in_progress`, `completed`). Adds `/todos` command and real-time terminal progress indicators.
* **`question.ts`**: Interactive multi-choice and write-in question modal UI.

---

## ⚙️ Configuration Templates

Sanitized configuration templates in `config/`:

* **`config/settings.json.example`**: Pre-configured with `defaultProvider: "opencode-go-proxy"`, `defaultThinkingLevel: "max"`, token reserve, and default packages.
* **`config/models.json.example`**: Complete provider schemas for direct Cloud APIs (DeepSeek Official, OpenAI) & OpenCode Go gateway proxy.
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

# 🥧 custom-pi

Custom extensions, tools, and configuration templates for [Pi Coding Agent](https://github.com/earendil-works/pi).

## 🚀 Features & Custom Extensions

This repository bundles custom TypeScript extensions for Pi located in `extensions/`:

* **`apply_patch.ts`**: Multi-file Git-style chunk patch tool (`*** Begin Patch ...`). Allows creating, updating, moving, and deleting multiple files in a single tool call.
* **`imageread.ts`**: Local VLM vision integration for text-only coding models. Supports low/high detail reading, tiling, and normalized crop zoom-ins.
* **`todo.ts`**: Interactive 3-state task list (`pending`, `in_progress`, `completed`). Adds the `/todos` command and real-time terminal progress indicators.
* **`question.ts`**: Interactive multi-choice and write-in question modal UI.

---

## ⚙️ Configuration Templates & Guides

Sanitized configuration templates are provided in `config/`:

* **`config/settings.json.example`**: Recommended global settings (reasoning level, compaction token headroom, packages).
* **`config/models.json.example`**: Provider configuration template supporting **OpenCode Go**, DeepSeek Cloud, and custom OpenAI-compatible proxies.
* **`config/web-search.json.example`**: 2-tier search routing setup (Exa → Brave fallback).

📖 **[OpenCode Go Provider Integration Guide](docs/OPENCODE_GO_GUIDE.md)**: Detailed setup guidelines for connecting Pi to the OpenCode Go gateway proxy, including model schemas, tracking headers (`X-Client-Id`), and multi-host (Tailnet) routing.

---

## 📥 Installation

Clone the repository and run `install.sh`:

```bash
git clone https://github.com/hojin12312/custom-pi.git
cd custom-pi
./install.sh
```

Or manually copy/link extensions to `~/.pi/agent/extensions/`:

```bash
mkdir -p ~/.pi/agent/extensions
cp extensions/*.ts ~/.pi/agent/extensions/
```

---

## 🔒 Privacy & Security

No private API keys, IP addresses, or environment-specific secrets are tracked in this repository. Ensure you update `settings.json` and `models.json` with your own credentials after installation.

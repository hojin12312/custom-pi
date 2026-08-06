# 🌐 OpenCode Go Provider Integration Guide for Pi

This guide details how to integrate and optimize **OpenCode Go** (the unified LLM gateway proxy) with [Pi Coding Agent](https://github.com/earendil-works/pi).

---

## 📌 Overview

OpenCode Go acts as an OpenAI-compatible gateway proxy (`openai-completions`) routing requests to various LLM backends (DeepSeek, Kimi, GLM, MiniMax, Qwen, Grok, etc.) with centralized authentication and token tracking.

---

## 🛠️ Configuration (`models.json`)

Add the `opencode-go` provider to `~/.pi/agent/models.json`:

```json
{
  "providers": {
    "opencode-go": {
      "baseUrl": "http://localhost:8104/v1",
      "api": "openai-completions",
      "apiKey": "local-go-proxy",
      "headers": {
        "X-Client-Id": "pi",
        "X-Project-Id": "pi"
      },
      "models": [
        {
          "id": "deepseek-v4-flash",
          "name": "DeepSeek V4 Flash (Go)",
          "contextWindow": 1048576,
          "cost": { "input": 0.14, "output": 0.28, "cacheRead": 0.0028, "cacheWrite": 0 }
        },
        {
          "id": "deepseek-v4-pro",
          "name": "DeepSeek V4 Pro (Go)",
          "contextWindow": 1048576,
          "cost": { "input": 0.435, "output": 0.87, "cacheRead": 0.003625, "cacheWrite": 0 }
        },
        {
          "id": "kimi-k3",
          "name": "Kimi K3 (Go)",
          "cost": { "input": 3.0, "output": 15.0, "cacheRead": 0.3, "cacheWrite": 0 }
        },
        {
          "id": "kimi-k2.7-code",
          "name": "Kimi K2.7 Code (Go)",
          "cost": { "input": 0.95, "output": 4.0, "cacheRead": 0.19, "cacheWrite": 0 }
        },
        {
          "id": "glm-5.2",
          "name": "GLM-5.2 (Go)",
          "cost": { "input": 1.4, "output": 4.4, "cacheRead": 0.26, "cacheWrite": 0 }
        },
        {
          "id": "minimax-m3",
          "name": "MiniMax M3 (Go)",
          "cost": { "input": 0.3, "output": 1.2, "cacheRead": 0.06, "cacheWrite": 0 }
        },
        {
          "id": "qwen3.7-max",
          "name": "Qwen3.7 Max (Go)",
          "cost": { "input": 2.5, "output": 7.5, "cacheRead": 0.5, "cacheWrite": 0 }
        },
        {
          "id": "grok-4.5",
          "name": "Grok 4.5 (Go)",
          "cost": { "input": 2.0, "output": 6.0, "cacheRead": 0.3, "cacheWrite": 0 }
        }
      ]
    }
  }
}
```

---

## 🔑 Important Integration Rules

### 1. Host Network vs Tailnet Addressing
* **Local Machine (e.g. Host Server)**: Use `http://localhost:8104/v1`
* **Remote Machine (e.g. Laptop / Secondary Node)**: Use Tailnet address `https://<host-tailnet-name>:8104/v1`

### 2. Mandatory Tracking Headers
Always pass `headers` to attribute token statistics in Usage Monitors:
```json
"headers": {
  "X-Client-Id": "pi",
  "X-Project-Id": "pi"
}
```
This ensures token consumption is logged under `client='pi'` in token proxy statistics databases (`tokens.db`).

### 3. Cost Schema Requirements
Every model definition in Pi **requires** all 4 cost fields (`input`, `output`, `cacheRead`, `cacheWrite`). Omitting `cacheWrite` will cause Pi to fail loading `models.json` with a schema validation error.

### 4. Setting OpenCode Go as Default Provider (`settings.json`)
Set `opencode-go` as your primary provider in `~/.pi/agent/settings.json`:
```json
{
  "defaultProvider": "opencode-go",
  "defaultModel": "deepseek-v4-flash",
  "defaultThinkingLevel": "max"
}
```

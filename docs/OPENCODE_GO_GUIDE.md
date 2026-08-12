# 🌐 OpenCode Go Provider Integration Guide for Pi

> ℹ️ **Note for General Users**: Most users connecting Pi directly to official Cloud APIs (DeepSeek Official, OpenAI, Anthropic, OpenRouter) **do not need a local proxy**. You can configure standard API endpoints (`https://api.deepseek.com/v1`, `https://api.openai.com/v1`) directly in `models.json`.
>
> This guide is intended for advanced setups using **OpenCode Go** (an internal unified gateway).

---

## 📌 Overview

OpenCode Go acts as an OpenAI-compatible gateway (`openai-completions`) routing requests to various LLM backends (DeepSeek, Kimi, GLM, MiniMax, Qwen, Grok, etc.) with centralized authentication and token tracking.

---

## 🛠️ Configuration (`models.json`)

Add the `opencode-go` provider to `~/.pi/agent/models.json`:

```json
{
  "providers": {
    "opencode-go": {
      "baseUrl": "http://localhost:8104/v1",
      "api": "openai-completions",
      "apiKey": "local-go-gateway",
      "headers": {
        "X-Client-Id": "pi",
        "X-Project-Id": "pi"
      },
      "models": [
        {
          "id": "deepseek-v4-flash",
          "name": "DeepSeek V4 Flash (Go)",
          "contextWindow": 1048576,
          "maxTokens": 384000,
          "reasoning": true,
          "input": ["text"],
          "thinkingLevelMap": {
            "off": "none",
            "minimal": null,
            "low": null,
            "medium": null,
            "high": "high",
            "xhigh": null,
            "max": "max"
          },
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
          "id": "qwen3.7-max",
          "name": "Qwen3.7 Max (Go)",
          "cost": { "input": 2.5, "output": 7.5, "cacheRead": 0.5, "cacheWrite": 0 }
        }
      ]
    }
  }
}
```

---

## 🧠 Setting DeepSeek Reasoning Effort to "Max"

DeepSeek reasoning models (such as DeepSeek V4 Flash / Reasoner) achieve significantly higher coding accuracy when allocated maximum reasoning tokens.

To force DeepSeek reasoning effort to **Max** in Pi:

### 1. Global Default Reasoning Level (`settings.json`)
Set `"defaultThinkingLevel": "max"` in `~/.pi/agent/settings.json`:
```json
{
  "defaultProvider": "opencode-go",
  "defaultModel": "deepseek-v4-flash",
  "defaultThinkingLevel": "max"
}
```

### 2. Thinking Level Mapping (`models.json`)
DeepSeek API expects thinking levels as `none`, `low`, `medium`, `high`, `max`. Sending unsupported values like `"off"` causes HTTP 400 parameter validation errors.

Ensure your `models.json` includes `thinkingLevelMap` for DeepSeek models:
```json
"reasoning": true,
"thinkingLevelMap": {
  "off": "none",
  "high": "high",
  "max": "max"
}
```

---

## 🔑 Integration Notes

### 1. Host Network vs Tailnet Addressing
* **Local Machine (e.g. Host Server)**: Use `http://localhost:8104/v1`
* **Remote Machine (e.g. Secondary Node)**: Use Tailnet address `https://<host-tailnet-name>:8104/v1`

### 2. Mandatory Tracking Headers
Always pass `headers` to attribute token statistics in Usage Monitors:
```json
"headers": {
  "X-Client-Id": "pi",
  "X-Project-Id": "pi"
}
```

### 3. Cost Schema Requirements
Every model definition in Pi **requires** all 4 cost fields (`input`, `output`, `cacheRead`, `cacheWrite`). Omitting `cacheWrite` will cause Pi to fail loading `models.json` with a schema validation error.

### 4. Watchdog Judge Uses the Same Local Gateway
The `abnormal-stop-watchdog` extension's judge call defaults to `http://localhost:8104/v1/chat/completions` (`PI_WD_JUDGE_URL`, model `PI_WD_JUDGE_MODEL` → `deepseek-v4-flash`; reasoning disabled via `reasoning_effort: none`) — the same local gateway described above. Remote hosts should point `PI_WD_JUDGE_URL` at their tailnet address and `X-Client-Id: watchdog` is sent for usage attribution.

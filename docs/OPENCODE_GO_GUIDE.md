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
            "minimal": null,
            "low": null,
            "medium": null,
            "high": "high",
            "max": "max"
          },
          "compat": {
            "supportsStore": false,
            "supportsDeveloperRole": false,
            "maxTokensField": "max_tokens",
            "requiresReasoningContentOnAssistantMessages": true,
            "thinkingFormat": "deepseek"
          },
          "cost": { "input": 0.14, "output": 0.28, "cacheRead": 0.0028, "cacheWrite": 0 }
        },
        {
          "id": "deepseek-v4-pro",
          "name": "DeepSeek V4 Pro (Go)",
          "contextWindow": 1048576,
          "maxTokens": 384000,
          "reasoning": true,
          "thinkingLevelMap": {
            "minimal": null,
            "low": null,
            "medium": null,
            "high": "high",
            "max": "max"
          },
          "compat": {
            "supportsStore": false,
            "supportsDeveloperRole": false,
            "maxTokensField": "max_tokens",
            "requiresReasoningContentOnAssistantMessages": true,
            "thinkingFormat": "deepseek"
          },
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

> **🟢 2026-08-16 — thinking 복원 기준으로 갱신**: Pi 커스텀 `models.json` 정의는 내장 카탈로그(pi-ai
> `dist/providers/data/opencode-go.json`)의 동일 id 모델을 **통째로 교체**하므로, `reasoning`/`thinkingLevelMap`/
> `compat`/`maxTokens`를 명시하지 않으면 전부 기본값으로 떨어진다(이 때문에 한동안 Thinking Level 설정이 비활성화되고
> output이 16K로 캡됐었다). **위 예시가 복원된 정본이다** — 이 필드들을 빼먹지 말 것. 나머지 모델(glm·kimi·mimo·
> minimax-m3·qwen3.7-max·grok-4.5·gpt-5.6-luna·hy3)도 모델별 내장값(예: kimi-k3는 max 전용, grok-4.5는
> low/medium/high)을 그대로 복원했다. `off` 레벨은 맵에 키가 없어도 Pi가 `thinking: {type: "disabled"}`로 처리한다
> (`streamSimple`이 `off → undefined`로 변환 — 400 위험 없음). `input` 필드를 추가하면 Pi가 이미지를 직접 보내고
> `imageread` 도구를 숨기므로, 텍스트 전용으로 쓰려면 넣지 않는다.

---

## 🧠 Setting DeepSeek Reasoning Effort to "Max"

DeepSeek reasoning models (such as DeepSeek V4 Flash / Reasoner) achieve significantly higher coding accuracy when allocated maximum reasoning tokens.

To force DeepSeek reasoning effort to **Max** in Pi:

> ℹ️ **2026-08-16 현재 배포 기본값은 `"high"`다** (settings.json `defaultThinkingLevel`). 아래 1번은 원할 때
> max로 올리는 방법이며, `high`→`max`는 TUI에서 세션 중에도 바꿀 수 있다(opencode-go deepseek는 off/high/max 지원).

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
* **모든 머신 (Host/Secondary Node)**: `http://localhost:8104/v1` — **2026-08-16부터 MBP·PICS도
  자체 로컬 토큰 프록시(:8104)를 띄운다**(공인 `opencode.ai` 직결 + 로컬 버퍼 → Studio ingest sync).
  구 tailnet 주소(`https://studio.tailf8a255.ts.net:8104/v1`) 경유는 2026-08-15 이전 이력이다.
  상세: `server/infra/token-logging/CLAUDE.md` "원격 머신(MBP·PICS) 로컬 토큰 프록시 + sync".

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
The `abnormal-stop-watchdog` extension's judge call defaults to `http://localhost:8104/v1/chat/completions` (`PI_WD_JUDGE_URL`, model `PI_WD_JUDGE_MODEL` → `deepseek-v4-flash`; reasoning disabled via `reasoning_effort: none`) — the same local gateway described above. **2026-08-16부터 MBP·PICS도 로컬 :8104 프록시를 띄우므로 `PI_WD_JUDGE_URL`은 세 머신 모두 `localhost`로 통일된다**(구 tailnet 주소 불필요). `X-Client-Id: watchdog` is sent for usage attribution.

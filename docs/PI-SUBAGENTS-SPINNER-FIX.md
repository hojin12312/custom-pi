# 🌀 pi-subagents Async Widget Spinner Fix (local patch)

> **Status**: Applied to Mac Studio + MacBook Pro (2026-08-14) + PICS/simlab (2026-08-15) · Real-usage verification pending · Upstream PR decision pending
> **Versions**: pi-subagents 0.49.0 (npm) · pi 0.84.2
> **Upstream repo**: [nicobailon/pi-subagents](https://github.com/nicobailon/pi-subagents)

---

## Symptom

During an **async/background subagent chain**, the async status widget (bottom of the TUI, above the editor) either:

- **froze completely** during quiet stretches (e.g. a long single tool call with no status updates), or
- spun at a **low, jerky frame rate (~1 fps)** with unnatural frame jumps.

The parent's own `Working...` spinner (pi's built-in `Loader`, 80 ms interval) stays smooth — the contrast makes the widget look broken.

## Root cause (confirmed by code + measurement)

1. The widget spinner glyph is **wall-clock based**: `frame = Math.floor(Date.now() / 250)`
   (`src/tui/render.ts`). Any repaint shows a different glyph → a *static* glyph on screen means **no repaints happened at all**.
2. pi-subagents drives the widget animation with a 250 ms poller tick
   (`src/runs/background/async-job-tracker.ts`):
   ```js
   if (runningJobIds.size > 0) requestLastWidgetRender();
   ```
   which calls:
   ```js
   (ctx.ui as { requestRender?: () => void }).requestRender?.();
   ```
3. **`requestRender` does not exist on pi's `ExtensionUIContext`** — not in the type
   declaration (`dist/core/extensions/types.d.ts`), not in the interactive implementation
   (`createExtensionUIContext()` in `interactive-mode.js`), not in RPC mode. The optional
   chaining (`?.()`) silently swallows the missing method → **the 250 ms tick is a no-op**.
4. Consequently the widget only repaints on **job state changes** (fs.watch on the async
   run dir + 5 s liveness sweep → `refreshJob()` → `rerenderLastWidget()`).
5. **Measurement** (MBP, active async job): `status.json` was rewritten exactly every
   **1 second** (mtime 22:04:40 → 41 → … → 50) → widget repainted ~1 fps, glyph jumping
   ~4 frames per repaint. Stretches with no status.json writes → zero repaints → frozen.

## Patch

**File**: `~/.pi/agent/npm/node_modules/pi-subagents/src/runs/background/async-job-tracker.ts`, line 542

```diff
- if (runningJobIds.size > 0) requestLastWidgetRender();
+ if (runningJobIds.size > 0) rerenderLastWidget();
```

`rerenderLastWidget()` → `renderWidget()` → `ctx.ui.setWidget(...)` →
`setExtensionWidget()` → `renderWidgets()` → **the TUI's own `requestRender()`** — a
path that actually exists and repaints. The widget is rebuilt every 250 ms while a job
runs, so the wall-clock frame advances and the spinner animates at ~4 fps.

- **Applied on**: Mac Studio (`/Users/studio/.pi/agent/...`), MacBook Pro (`/Users/hjlee/.pi/agent/...`), PICS/simlab (`/home/hjlee/.pi/agent/...`, 2026-08-15)
- **Backup**: `async-job-tracker.ts.bak-spinnerfix-20260814` (Mac) / `async-job-tracker.ts.bak-spinnerfix-20260815` (PICS) next to the patched file
- **PICS/simlab (2026-08-15)**: pi-subagents를 0.43.0 → **0.49.0**으로 업그레이드한 뒤 같은 패치를 적용 — 0.43.0은 구버전 코드 경로(`rerenderLastWidget` 존재 but 라인 상이)라 그대로 못 쓰니 반드시 0.49.0 업그레이드 후 적용한다.
- **Loading**: the extension is loaded at pi startup; run `/reload` in the session (or restart pi) to pick up the patch. Jobs started *before* `/reload` still run the old code.

### Re-apply after a package update (npm install overwrites the file)

```bash
sed -i '' \
  's/if (runningJobIds.size > 0) requestLastWidgetRender();/if (runningJobIds.size > 0) rerenderLastWidget();/' \
  ~/.pi/agent/npm/node_modules/pi-subagents/src/runs/background/async-job-tracker.ts
```

### Rollback

```bash
cp ~/.pi/agent/npm/node_modules/pi-subagents/src/runs/background/async-job-tracker.ts.bak-spinnerfix-20260814 \
   ~/.pi/agent/npm/node_modules/pi-subagents/src/runs/background/async-job-tracker.ts
```

## Why it's a bug, not a design choice

- The parent's main area showing no spinner during an async run **is** intentional (the
  parent's turn ended; the `Working...` indicator only exists while the parent calls its model).
- But the **widget spinner freezing / running at ~1 fps is not** — the extension's own
  changelog claims the opposite:
  - #983 / #216: "Keep async widget running glyphs moving while children are quiet but active"
  - #198: "Stop quiet async status widget animation redraws from spilling progress updates…"
  The mechanism those fixes rely on (`ctx.ui.requestRender`) is a silent no-op in the
  interactive TUI, so the intended animation never actually runs there.

## Where the defect lives

| Side | Role |
|---|---|
| **pi-subagents** (primary) | Depends on `ctx.ui.requestRender`, which pi never exposes; the `as { requestRender?: () => void }` cast + `?.()` hide the failure; its "keep glyphs moving" fix (#983) doesn't work |
| **pi** (secondary) | `ExtensionUIContext` provides no way for extensions to request a TUI repaint on their own timer |

## Next steps (pending real-usage verification)

- [ ] Verify in real use: widget spins at ~4 fps and does not freeze during quiet stretches
- [ ] On success, decide upstream action:
  - open a PR to [nicobailon/pi-subagents](https://github.com/nicobailon/pi-subagents)
    (drive animation through `setWidget` re-set, which works), and/or
  - propose adding `requestRender()` to pi's `ExtensionUIContext`
    ([earendil-works/pi](https://github.com/earendil-works/pi), `packages/coding-agent`)

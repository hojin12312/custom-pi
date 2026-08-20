# 🛠 bg.ts Architectural Redesign — Implementation Plan

> **Status**: ✅ Phase 1~3 구현 완료 (2026-08-20) · **Author**: custom-pi maintainers · **Created**: 2026-08-19 (KST) · **Revised**: 2026-08-19 (KST) — 코드 대조 리뷰 반영 + 사소한 이슈 3개 패치(v2.1-A/B/C), 변경 이력 §15 · **Implemented**: 2026-08-20 (KST) — Phase 1~3 일괄 구현 (사용자 지시로 모니터링 대기 없이 진행), 구현 이력 §15.2
> **Scope**: `extensions/bg.ts` 전면 redesign (wrapper 스크립트 + `/bg` 커맨드 + `ctrl+q` 정책)
> **관련 이슈**: tail 고아 누적, 파이프 오염, `pkill` 자기 재귀, 무조건 래핑 오버헤드

---

## 1. 배경 및 동기

### 1.1 현재 상태

`extensions/bg.ts`는 4가지 미해결 근본 원인을 갖고 있다 (2026-08-19 기준, Pi 0.84.2 / pi-subagents 0.51.0):

| # | 근본 원인 | 증상 |
|---|---|---|
| ① | `tail -f &`가 fd 1/2 상속 | 파이프 수명 연장 → 다음 명령 출력 오염 |
| ② | kill 비동기 + `wait "$TAILPID"` 누락 + `trap EXIT` 부재 | 좀비/고아 tail 누적 |
| ③ | 프로세스 그룹 격리 없음 | `pkill -f 'tail.*pi-bg'` 자기 재귀 |
| ④ | 무조건 래핑 + opt-out 방식 | 단순 `echo`도 4프로세스 + 0.5s 폴링 |

최근 업스트림 커밋 `dc79e5e`는 **별개 이슈**(Node.js 이벤트 루프 hang, `pi -p` 종료 안 됨)만 수정했고, 위 4가지 원인은 **전혀 손대지 않았다**.

### 1.2 왜 패치 대신 redesign인가

5가지 패치(EXIT trap + wait + SIGKILL 에스컬레이션 + setsid + opt-in)를 모두 적용해도:
- 래퍼 스크립트가 여전히 복잡 (60+ 줄 bash)
- tail이 여전히 존재 (제거해도 fd 격리 필요)
- opt-in 마커를 모델이 깜빡할 위험
- `ctrl+q` mid-execution 시나리오 처리가 모호

**Redesign은 버그 클래스 자체를 제거**한다. 래퍼를 최소화하고, tail을 없애고, opt-in을 슬래시 커맨드로 명시화.

> **📌 2026-08-19 리뷰 결정 (D1)**: 래퍼 **패치 유지(안 a) vs redesign(안 b)** 의결 → **안 b(redesign) 채택**.
> 근거: 5종 패치라도 60+줄 래퍼 bash·tail·SIGUSR1 race가 남아 유지보수 부담이 크고,
> mid-execution 전환은 시작 시점 opt-in(`/bg`·`# bg:run`)으로 대체 가능.
> 단, 리뷰에서 확인된 **에이전트 백그라운딩 경로 소실**(모델은 슬래시 커맨드를 실행할 수 없음)
>은 `# bg:run` 마커로 복원한다 (G8, §5.1, R1 개정 — 변경 이력 §15 참조).

---

## 2. 목표 및 비목표

### 2.1 목표 (Goals)

| ID | 목표 |
|---|---|
| **G1** | 고아 tail 프로세스 누적 제거 |
| **G2** | 크로스 명령 출력 오염 제거 |
| **G3** | `pkill` 자기 재귀 위험 제거 |
| **G4** | 단순 명령의 래퍼 오버헤드 제거 (zero wrapper for default) |
| **G5** | 기존 UX 보존: 완료 자동 주입, `/bglist`, `/bgkill`, 세션별 격리 |
| **G6** | 기존 `/tmp/pi-bg/<jobid>/` 데이터 하위 호환 |
| **G7** | `pi -p` 모드 정상 종료 (이벤트 루프 hang 없음) |
| **G8** | (리뷰 추가) 에이전트가 bash 툴로 자기 긴 명령을 백그라운딩할 수 있음 (`# bg:run` 마커 — 모델은 슬래시 커맨드를 실행할 수 없음) |

### 2.2 비목표 (Non-Goals)

| ID | 비목표 |
|---|---|
| **N1** | 백그라운드 명령의 실시간 TUI 스트리밍 (deferred — 후속 enhancement) |
| **N2** | `ctrl+q`가 non-`/bg` 명령에 동작 (의도된 동작 변경 — D1: mid-execution 전환은 폐기하고 시작 시점 opt-in으로 대체) |
| **N3** | `bgnow`의 SIGUSR1 기반 mid-execution 백그라운딩 (deprecated) |
| **N4** | Windows 네이티브 지원 (Unix 전용 — `setsid`, `process.kill(-pid)` 의존) |

---

## 3. 현재 아키텍처 (문제)

```
┌─────────────────────────────────────────────────────────────┐
│ Pi bash tool → wrapper (bash)                               │
│   ├─ { eval cmd; echo $? > exit; } >"$LOG" 2>&1 &  ← JOBPID│
│   ├─ tail -f "$LOG" &                            ← TAILPID  │ ← fd 1/2 상속
│   └─ while kill -0 JOBPID; do sleep 0.5; done              │ ← 0.5s 폴링
│       ↓ JOBPID 종료                                         │
│   kill TAILPID (비동기, reap 안 함)                          │
│   wait JOBPID                                               │
│   exit                                                      │
└─────────────────────────────────────────────────────────────┘
        ↓
   TAILPID 고아 → 파이프 점유 → 다음 명령 출력 오염
```

**핵심 문제**:
- tail이 래퍼의 stdout/stderr를 상속 → tail이 살아있는 한 파이프 닫히지 않음
- `wait "$JOBPID"`만 하고 `wait "$TAILPID"` 안 함 → TAILPID 좀비/고아
- `trap EXIT` 없음 → 비정상 종료 시 정리 안 됨
- 래퍼가 PGID 리더 아님 → 시그널 전파 예측 불가

---

## 4. 목표 아키텍처

```
┌─────────────────────────────────────────────────────────────┐
│ /bg <cmd>  ──→  Extension (Node.js)                          │
│                  ├─ mkdir /tmp/pi-bg/<jobid>/                │
│                  ├─ write cmd, session, backgrounded         │
│                  ├─ spawn(bash, [script], {detached:true})   │ ← 새 PGID
│                  │     └─ script: eval cmd; echo $? > exit  │
│                  └─ child.unref()                            │
│                                                               │
│   (이후 wrapper/bash 없음 — extension이 직접 spawn)           │
└─────────────────────────────────────────────────────────────┘
        ↓
   fs.watch(BG_DIR) → 완료 감지 → pi.sendMessage(auto-inject)
   (macOS: fs.watch 즉시 / Linux: 5s polling sweep — v2.1-C)
```

**에이전트 경로 (리뷰 추가, G8)** — 모델은 슬래시 커맨드를 칠 수 없으므로 bash 명령 내 마커로 opt-in:

```
┌─────────────────────────────────────────────────────────────┐
│ bash tool: "<cmd> # bg:run"  ──→  tool_call 핸들러           │
│   └─ 마커 제거 후 spawnBackground() 경로로 재작성             │
│      (실제 실행은 위와 동일한 detached bash — 래퍼 없음)       │
│      툴 콜은 즉시 "job=<id>" 반환 → 완료 시 자동 주입(§5.5)   │
└─────────────────────────────────────────────────────────────┘
```

**핵심 변화**:
- **래퍼 스크립트 제거** — Extension이 Node.js `spawn`으로 직접 명령 실행
- **tail 제거** — 로그 스트리밍은 extension의 `fs.watch` + `readFile`로 (필요 시)
- **opt-in 명시화** — 사용자: `/bg <cmd>` · 에이전트: `# bg:run` 마커. 나머지는 통과
- **`detached: true`** — Node.js가 Unix에서 자동으로 새 process group 생성 (`setsid` 불필요)

> **⚠️ 완료 감지 (리뷰 수정 R-10)**: macOS는 `fs.watch` 즉시 감지, **Linux는 `fs.watch`를
> 쓰지 않고 5s 폴링 sweep만** 사용한다 (dc79e5e: Linux/Node 22에서 `FSWatcher.unref()` 무효
> → `pi -p` hang). 위 다이어그램의 `fs.watch`는 macOS 경로임 — Linux 즉시성은 0→≤5s.


---

## 5. 상세 컴포넌트 설계

### 5.1 Extension 측: `/bg` 슬래시 커맨드

**파일**: `extensions/bg.ts`

```typescript
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, openSync, closeSync } from "node:fs";

const BG_DIR = process.env.PI_BG_DIR?.trim() || "/tmp/pi-bg";

interface BgOptions {
    cmd: string;
    sessionId: string;
    quiet?: boolean;
}

function spawnBackground({ cmd, sessionId, quiet = false }: BgOptions): {
    jobId: string;
    jobPid: number;
    logPath: string;
} {
    const jobId = `${process.pid}-${Date.now()}`;
    const jobDir = `${BG_DIR}/${jobId}`;
    mkdirSync(jobDir, { recursive: true });

    // 메타데이터 기록
    writeFileSync(`${jobDir}/cmd`, cmd);
    writeFileSync(`${jobDir}/session`, sessionId);
    writeFileSync(`${jobDir}/backgrounded`, "1"); // /bg는 항상 backgrounded
    if (quiet) writeFileSync(`${jobDir}/quiet`, "1");

    const logPath = `${jobDir}/log`;
    const logFd = openSync(logPath, "w");

    // (리뷰 수정 R-4) 명령 임베드 방식: `eval ${JSON.stringify(cmd)}`는 불가 —
    // bash 이중인쇄 문자열은 JSON 이스케이프를 해석하지 않아 \n 등이 리터럴로
    // 남고 다중 라인 명령이 깨진다. 대신 Node가 cmd 파일을 평문으로 직접 쓰고
    // (위 메타데이터 기록), 스크립트는 그 파일을 eval한다.
    // 스크립트는 eval + exit code 기록만 (최소)
    const jobScript = [
        `set +e`,
        `eval "$(cat ${JSON.stringify(`${jobDir}/cmd`)})"`,
        `C=$?`,
        `echo "$C" > ${JSON.stringify(`${jobDir}/exit`)}`,
        `exit $C`,
    ].join("\n");

    // detached:true → Unix에서 새 process group, Windows에서는 무시
    const child = spawn("bash", ["-c", jobScript], {
        detached: true,
        stdio: ["ignore", logFd, logFd],
    });
    child.unref();
    // (리뷰 수정 R-5) 부모의 logFd 즉시 close — 안 닫으면 job 수만큼
    // pi 프로세스 fd가 영구 점유된다 (자식은 spawn 시 dup된 자체 fd 보유).
    closeSync(logFd);

    writeFileSync(`${jobDir}/jobpid`, String(child.pid));
    writeFileSync(`${jobDir}/pid`, String(child.pid)); // backward-compat

    return { jobId, jobPid: child.pid, logPath };
}
```

**`/bg` 핸들러**:

```typescript
pi.registerCommand("bg", {
    description: "Run a command in background (usage: /bg <command>)",
    handler: async (args, ctx) => {
        const cmd = args.trim();
        if (!cmd) {
            ctx.ui.notify("사용법: /bg <command>  (예: /bg npm install)", "warning");
            return;
        }
        const sessionId = ctx.sessionManager.getSessionId();
        const quiet = cmd.includes("# bg:quiet");
        const cleaned = quiet ? cmd.split("# bg:quiet").join("") : cmd;

        const { jobId, jobPid, logPath } = spawnBackground({
            cmd: cleaned,
            sessionId,
            quiet,
        });

        ctx.ui.notify(
            `[bg] 백그라운드 시작\n` +
            `  job: ${jobId}\n` +
            `  pid: ${jobPid}\n` +
            `  log: ${logPath}\n` +
            `완료 시 자동으로 보고됩니다. /bglist로 상태 확인.`,
            "info",
        );
    },
});
```

> (Phase 1에서는 위 커맨드를 `"bgrun"` 이름으로 등록 — 기존 `/bg [id]`와 이름 충돌,
> §7 Phase 1 · 변경 이력 R-3. Phase 2에서 `/bg`로 승격.)

**`tool_call` 핸들러 변경 (리뷰 수정 R-1 — G8)**:

모델은 슬래시 커맨드를 실행할 수 없으므로, 에이전트용 opt-in은 bash 명령 내
`# bg:run` 마커로 제공한다. 마커가 있는 명령만 `spawnBackground()` 경로로
재작성하고, 나머지는 **통과(래핑 없음 — G4 유지)** 한다.

```typescript
// (v2.1-B: QUIET_MARKER 정의 스니펫에 추가 — 아래 핸들러가 참조함)
const BG_RUN_MARKER = "# bg:run";
const QUIET_MARKER = "# bg:quiet";

pi.on("tool_call", (event, ctx) => {
    if (event.toolName !== "bash" || typeof event.input.command !== "string") return;
    const cmd = event.input.command;
    if (!cmd.includes(BG_RUN_MARKER)) return; // 기본: 무래핑 통과 (G4)
    const quiet = cmd.includes(QUIET_MARKER);
    const cleaned = cmd.split(BG_RUN_MARKER).join("").split(QUIET_MARKER).join("").trim();
    if (!cleaned) return;
    const { jobId } = spawnBackground({
        cmd: cleaned,
        sessionId: ctx.sessionManager.getSessionId(),
        quiet,
    });
    // 툴 콜은 즉시 "백그라운딩 완료"로 끝남 — 실제 작업은 detached bash가 수행
    // (v2.1-A: "moved to" → "started in" — `# bg:run`은 실행 전 백그라운딩이므로
    //  mid-execution 전환(ctrl+q)과 구분)
    event.input.command = `echo "[bg] started in background job=${jobId} (완료 시 자동 통지됩니다)"`;
});
```

**동작**: 모델이 `bash: "npm install # bg:run"`를 호출하면 툴 콜은 즉시 job id와
함께 반환되고, 작업은 백그라운드에서 돌며 완료 시 기존 자동 주입(§5.5)으로 결과가
에이전트 큐에 돌아온다 — **사용자 개입 0회**의 폐루프 (D1 결정의 핵심).

### 5.2 `ctrl+q` 동작 변경

**이전**: 모든 bash 명령이 래핑되어 있으므로 `ctrl+q`가 어디서나 동작
**이후**: `/bg`로 시작된 명령만 래퍼가 있으므로 `ctrl+q`도 해당 명령에만 동작

```typescript
pi.registerShortcut("ctrl+q", {
    description: "Show status of background jobs (was: send running bash to background)",
    handler: async (ctx) => {
        const sessionId = ctx.sessionManager.getSessionId();
        const jobs = scanJobs().filter(
            (j) => j.sessionId === sessionId && j.backgrounded && j.status === "running",
        );
        if (jobs.length === 0) {
            ctx.ui.notify(
                "[bg-s] 백그라운드 작업 없음. 백그라운드 전환이 필요한 명령은 /bg 로 실행하세요.",
                "info",
            );
            return;
        }
        // 가장 최근 작업의 마지막 로그 10줄 표시
        const latest = jobs.sort((a, b) => b.started - a.started)[0];
        const tail = lastLines(readTailFile(latest.logPath, 4096), 10);
        ctx.ui.notify(
            `[bg-s] 실행 중: ${latest.id} (pid=${latest.jobPid})\n${tail}\n` +
            `전체 로그: ${latest.logPath}\n` +
            `중단: /bgkill ${latest.id}`,
            "info",
        );
    },
});
```

**동작 변경 요약**:

| 시나리오 | 이전 | 이후 |
|---|---|---|
| `ctrl+q` during 일반 명령 | 백그라운드 전환 | "백그라운드 작업 없음. /bg 로 실행하세요" 안내 |
| `ctrl+q` during `/bg` 명령 | (해당 없음 — 이미 백그라운드) | 상태 표시 (pid + 마지막 로그) |
| `pkill -f 'tail.*pi-bg'` | 자기 재귀 위험 | tail 자체가 없음 → 무해 |


### 5.3 작업 스캔 / 정리 (기존 코드 보존)

`scanJobs()`, `readTailFile()`, `isAlive()`, `lastLines()`, `cmdSummary()`는 그대로 유지. 변경점:

- `pid` 필드 의미 변경: 기존(래퍼 PID) → 신규(작업 bash PID = jobpid와 동일)
- `wrapperAlive` 체크는 무의미해지지만 **하위 호환을 위해 유지** (구 래퍼가 돌고 있을 수 있음)
- `STALE_MS` 정리는 그대로 (24h 후 완료/유실 작업 자동 삭제)

### 5.4 작업 종료 (`/bgkill`) — PGID 기반 그룹 킬

```typescript
function killJob(j: JobInfo): boolean {
    if (!isAlive(j.jobPid)) return false;
    // (리뷰 수정 R-8) 폴백 순서: 신규 job은 -jobPid(PGID) → 전환기 구 형식 job은
    // PGID 리더가 wrapper이므로 -wrapperPid → 마지막에 개별 PID.
    const groupKills = [
        () => process.kill(-j.jobPid, "SIGTERM"),      // 신규: detached bash = PGID 리더
        () => process.kill(-j.wrapperPid, "SIGTERM"),  // 구 형식: wrapper = PGID 리더
        () => process.kill(j.jobPid, "SIGTERM"),       // 개별 폴백
    ];
    let delivered = false;
    for (const kill of groupKills) {
        try { kill(); delivered = true; break; } catch { /* 다음 폴백 */ }
    }
    if (!delivered) return false;
    // 2초 후에도 살아있으면 SIGKILL
    // (리뷰 수정 R-9) .unref() — pi -p(원샷)에서 이 타이머만으로 프로세스가
    // 2s 더 살지 않게 (G7 유지). 단, 호스트가 실제로 먼저 종료하면 에스컬레이션은
    // 수행되지 않는다 — SIGTERM만 전달된 상태로 남음 (허용, 문서화).
    setTimeout(() => {
        if (isAlive(j.jobPid)) {
            try { process.kill(-j.jobPid, "SIGKILL"); }
            catch { try { process.kill(j.jobPid, "SIGKILL"); } catch {} }
        }
    }, 2000).unref();
    return true;
}
```

### 5.5 완료 자동 주입 (기존 유지)

`flushNotices()`, `sweep()`, `queueNotice()`, `markSeenAtLoad()`는 그대로 유지. 변경 없음.

**향후 개선 (이번 redesign 범위 외)**:
- 통지 메시지에 전체 로그 전문 포함 가능 (현재는 마지막 6줄만)
  - 이유: 이전엔 다음 명령 오염 방지로 tail만 했지만, redesign 후엔 안전
- `/bglist`에 진행 중 작업의 마지막 N줄 실시간 표시 (fs.watch 기반)

### 5.6 `/bglist` / `/bgkill` 등록 — 무조건 등록

```typescript
// 이전: bgCommandsRegistered 플래그로 조건부 등록
// 이후: 항상 등록 (조건 없음 — /bg 자체가 명시적 opt-in)
pi.registerCommand("bglist", { /* ... */ });
pi.registerCommand("bgkill", { /* ... */ });
```

`registerBgCommands()` 함수와 `bgCommandsRegistered` 플래그, `hasBackgroundedJob()` 조건부 등록 로직 **전부 제거**.

### 5.7 `bgnow` 헬퍼 스크립트 — deprecated

**파일**: `scripts/bgnow`

**옵션 A (제거)**: `install.sh`에서 복사하지 않음. README에서 언급 삭제.

**옵션 B (재목적)**: 상태 조회 전용으로 전환:
```bash
#!/usr/bin/env bash
# bgnow — query background job status (no more SIGUSR1)
case "${1:-list}" in
    list|ls)     # /bglist와 동일 — /tmp/pi-bg/<session>/ 스캔
        ;;
    status|s)    # bgnow status <jobid> — 마지막 20줄 출력
        ;;
    kill|k)      # bgnow kill <jobid> — kill -- -<jobpid>
        ;;
    *) echo "Usage: bgnow {list|status <id>|kill <id>}" ;;
esac
```

**권장**: 옵션 B (하위 호환 + 새 기능). 기존 사용자가 `bgnow <pid>`를 호출하면 deprecation 경고 후 status로 폴백.

### 5.8 마커 정리 (리뷰 수정 R-1)

| 마커 | 이전 | 이후 |
|---|---|---|
| `# bg:off` | 래핑 opt-out | **제거** — 무조건 래핑이 없어져 무의미 |
| `# bg:on` | (없음) | **`# bg:run`으로 대체** — 에이전트용 opt-in (§5.1, G8) |
| `# bg:run` | (신규) | **추가** — bash 명령에 포함 시 `spawnBackground()` 경로로 재작성 |
| `# bg:quiet` | 통지 억제 | **유지** — `/bg`·`# bg:run` 명령 모두에서 동작 |

### 5.9 환경 변수 정리

| 변수 | 이전 | 이후 |
|---|---|---|
| `PI_BG_DIR` | 유지 | 유지 (기본 `/tmp/pi-bg`) |
| `PI_BG_SWEEP_MS` | 유지 | 유지 (폴링 간격, 기본 5000) |
| `PI_BG_DEBOUNCE_MS` | 유지 | 유지 (배치 디바운스, 기본 1500) |
| `PI_BG_STALE_MS` | (없음, 하드코딩 24h) | 신규 — STALE_MS 오버라이드 |
| `PI_BG_OPT_IN` | (없음) | 신규 — opt-in 모드 플래그 (`1` = Phase 2 동작). (리뷰 수정 R-11: settings.json `bg.useOptIn` 대신 env var — extension은 현재 env var만 읽고 `PI_BG_*` 패턴 통일) |

---

## 6. 데이터 모델 및 파일 레이아웃

`/tmp/pi-bg/<jobid>/`:

| 파일 | 내용 | 이전 | 이후 |
|---|---|---|---|
| `pid` | PID | 래퍼 PID | 작업 bash PID (= jobpid) |
| `jobpid` | 작업 PID | 작업 PID | 작업 bash PID |
| `cmd` | 원본 명령 | 평문 (래퍼가 base64 디코드 후 기록) | 평문 (Node가 직접 기록 — 변경 없음) |
| `session` | Pi 세션 ID | 평문 (래퍼가 base64 디코드 후 기록) | 평문 (Node가 직접 기록 — 변경 없음) |
| `log` | stdout+stderr | wrapper가 작성 | Node.js가 직접 작성 |
| `exit` | 종료 코드 | 작업이 작성 | 작업이 작성 (변경 없음) |
| `backgrounded` | 백그라운드 마커 | ctrl+q 시 작성 | 항상 존재 |
| `notified` | 통지 마커 | extension이 작성 | (변경 없음) |
| `quiet` | 통지 억제 | (조건부) | (조건부, 변경 없음) |

**하위 호환 (리뷰 수정 R-7)**: 현행 래퍼는 `cmd`/`session`을 base64 **디코드 후 평문**으로
기록하므로 디코드 폴백은 불필요하다. 실제 전환기 호환 문제는 **`pid` 파일 의미**
(구=wrapper PID, 신=job bash PID)뿐 — `killJob`의 `-wrapperPid` 폴백(§5.4)이 이를
커버하고, `STALE_MS` 후 구 job은 자동 정리된다.


---

## 7. 마이그레이션 경로

### Phase 1: 병렬 배포 (1주일 검증)

**목표**: 기존 동작 유지하면서 `/bg` 경로 추가

**변경사항**:
1. `extensions/bg.ts`에 `spawnBackground()` 추가
2. **신규 사용자 커맨드는 `/bgrun <cmd>`로 등록** (리뷰 수정 R-3: 기존 `/bg [id]`=실행 중 작업 전환과
   이름 충돌 — 같은 이름에 두 의미를 `registerCommand`로 등록할 수 없음. Phase 2에서 `/bg`로 승격)
3. `# bg:run` 마커 처리 추가 (§5.1) — 기존 무조건 래핑과 공존하므로, 마커 명령만
   래핑에서 제외하고 `spawnBackground()`로 재작성
4. 기존 `wrapCommand()` + `tool_call` 핸들러는 나머지 명령에 대해 **그대로 유지**
5. `PI_BG_OPT_IN` env var 문서화 (리뷰 수정 R-11, settings.json 플래그 대신)
6. README에 `/bgrun`·`# bg:run` 사용법 추가 (기존 ctrl+q 동작은 유지)

**검증 항목**:
- [ ] `/bgrun sleep 5 && echo done` → 즉시 반환, 5초 후 자동 통지
- [ ] `bash: "sleep 5 && echo done # bg:run"` (에이전트) → 툴 콜 즉시 반환 + 완료 자동 통지
- [ ] 기존 ctrl+q 동작 그대로 (마커 없는 bash 명령 백그라운드 전환)
- [ ] `pi -p` 모드 정상 종료

### Phase 2: 기본값 전환 (Phase 1 검증 후)

**목표**: `PI_BG_OPT_IN=1` 동작이 기본값. 무조건 래핑 제거.

**변경사항**:
1. `PI_BG_OPT_IN=1`이 기본 동작으로 전환 (env var — R-11)
2. `tool_call` 핸들러에서 `wrapCommand()` 호출 제거 — `# bg:run` 마커 명령만
   `spawnBackground()`로 재작성, 나머지는 통과 (단, `wrapCommand` 함수는 export 유지 — 롤백용)
3. `/bgrun`을 `/bg`로 승격 (구 `/bg [id]` 전환 의미 제거)
4. `ctrl+q` 핸들러를 §5.2의 "상태 표시" 버전으로 교체
5. README에서 ctrl+q의 "백그라운드 전환" 설명을 "상태 표시"로 변경
6. `bgCommandsRegistered` 조건부 등록 로직 제거

**검증 항목**:
- [ ] Phase 1의 모든 검증 항목
- [ ] 단순 `echo hi`가 래핑 없이 즉시 실행 (오버헤드 제거 확인)
- [ ] `pkill -f 'tail.*pi-bg'` 실행 시 자기 재귀 없음
- [ ] 다음 명령 출력에 이전 tail 에러 없음 (오염 제거 확인)

### Phase 3: 정리 (Phase 2 안정화 후)

**목표**: deprecated 코드 제거

**변경사항**:
1. `wrapCommand()` 함수 완전 제거
2. `# bg:off` 마커 처리 코드 제거 (`# bg:run`/`# bg:quiet`는 유지)
3. `bgnow`를 §5.7 옵션 B로 재작성
4. `install.sh`에서 `bgnow` 설치 부분 유지 (재작성된 버전)
5. README의 "Notes" 섹션에서 `# bg:off` 언급 제거

---

## 8. 테스트 계획

### 8.1 단위 테스트 (`tests/bg-redesign.test.mjs` 신규)

```javascript
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const BG_DIR = "/tmp/pi-bg-test";
process.env.PI_BG_DIR = BG_DIR;

test("spawnBackground creates expected directory structure", async () => {
    // ... /bg 호출 시뮬레이션
});

test("spawned job runs in new process group", async () => {
    // ... spawn 후 ps -o pgid,pid로 PGID 검증
});

test("completion writes exit code", async () => {
    // /bg false → exit=1, /bg true → exit=0
});

test("killJob terminates entire process group", async () => {
    // /bg 'sleep 100 & sleep 100' → kill -- -PID로 둘 다 종료 확인
});

test("no orphan tail processes after completion", async () => {
    // /bg 'echo hi' → ps에서 tail 프로세스 0개 확인
});

test("# bg:quiet suppresses notification", async () => {
    // /bg 'echo done # bg:quiet' → 자동 통지 없음
});
```

### 8.2 회귀 테스트 (`tests/bg-regression.test.mjs` 기존) (리뷰 수정 R-6)

기존 테스트는 **래핑 + ctrl+q SIGUSR1 플로우를 직접 검증**하므로 Phase 2/3에서는
**그대로 통과할 수 없다** — 페이즈별 처리:

| 페이즈 | 기존 테스트 처리 |
|---|---|
| Phase 1 | 그대로 통과해야 함 (구 경로 유지 — 마커 명령 제외 로직만 추가) |
| Phase 2 | 래핑/SIGUSR1 의존 케이스(`backgroundAndFinish` 등)는 **폐기 표시** 후 `bg-redesign.test.mjs`의 동등 케이스로 대체. 유지되는 불변 검증: `sweep` export, `/tmp/pi-bg/<jobid>/` 스캔, 완료 자동 주입(`flushNotices`) 1회 보장, 세션 스코핑 |
| Phase 3 | 폐기된 케이스 물리 삭제 |

### 8.3 통합 테스트 (수동 체크리스트)

| 시나리오 | 기대 결과 |
|---|---|
| `/bg npm install` (긴 설치) | 즉시 반환, 설치 진행 중 로그 파일 증가, 완료 시 자동 통지 |
| `/bg 'sleep 3 && echo done'` | 3초 후 "done" 포함된 자동 통지 |
| `/bg 'exit 42'` | exit=42 포함된 자동 통지 |
| `/bg 'echo hi # bg:quiet'` | 자동 통지 없음, `/bglist`에 표시 |
| `/bglist` (작업 3개) | 3개 모두 상태 + 마지막 로그 |
| `/bgkill <id>` (실행 중) | SIGTERM → 2초 후 SIGKILL, 그룹 내 모든 프로세스 종료 |
| `/bgkill <id>` (이미 완료) | "이미 종료되었습니다" 경고 |
| `ctrl+q` (작업 없음) | "백그라운드 작업 없음. /bg 로 실행하세요" 안내 |
| `ctrl+q` (작업 실행 중) | 상태 표시 (pid + 마지막 로그 10줄) |
| `bash: "sleep 3 && echo done # bg:run"` (에이전트, G8) | 툴 콜 즉시 반환(job id 포함), 3초 후 자동 통지 |
| `bash: "printf 'a\\nb' # bg:run"` (다중 라인 명령 — R-4) | 2줄 모두 로그에 정상 기록 (cmd 파일 eval 방식 검증) |
| `pi -p "/bg sleep 100"` | 명령은 백그라운드, pi -p는 다른 작업 계속 |
| `pi -p` (백그라운드 작업 없음) | 정상 종료 (이벤트 루프 hang 없음) |
| `pkill -f 'tail.*pi-bg'` | 무해 (tail 자체가 없음) |

### 8.4 부하 테스트

- 100개 연속 `/bg 'sleep 0.1'` → 모두 추적, 모두 자동 통지, 고아 프로세스 0개
- 10개 동시 `/bg 'while true; do echo x; sleep 1; done'` → 10개 모두 `/bglist`에 표시, 각각 독립적으로 kill 가능

---

## 9. 롤백 전략

| 단계 | 롤백 방법 |
|---|---|
| Phase 1 | `PI_BG_OPT_IN` 미설정(=0) → 기존 무조건 래핑 복귀 |
| Phase 2 | `wrapCommand` 함수 export 유지 → 일시적으로 `tool_call` 핸들러에 복원 |
| Phase 3 | git revert로 커밋 단위 롤백 |

**데이터 보존**: `/tmp/pi-bg/<jobid>/` 디렉토리는 어떤 단계에서도 삭제하지 않음. 24h 후 `STALE_MS` 정리 로직이 자동 처리.

**긴급 비활성화**: `extensions/bg.ts` 파일을 `~/.pi/agent/extensions/`에서 제거 + `/reload` (기존 uninstall 경로와 동일).


---

## 10. 문서 업데이트

| 파일 | 변경 |
|---|---|
| `README.md` | `bg.ts` 섹션 재작성: `/bg` 커맨드 사용법, ctrl+q 동작 변경, `# bg:off` 제거 |
| `install.sh` | 변경 없음 (스크립트 복사 동일) |
| `scripts/bgnow` | §5.7 옵션 B로 재작성 (status/list/kill) |
| `extensions/bg.ts` | 전면 redesign (이 문서의 §5) |
| `tests/bg-redesign.test.mjs` | 신규 (이 문서의 §8.1) |
| `docs/BG-REDESIGN-PLAN.md` | 본 문서 |

### README.md 변경 상세 (예정)

**이전** (line 36-40):
```markdown
* 🕐 **`bg.ts` (Bash Background Runner)**: Long-running bash commands (downloads, builds)
  can be pushed to the background so the agent keeps working on other tasks.
  * **`ctrl+q` during a tool run** — moves the running command owned by the
    **current Pi session** to background: the tool call returns immediately with a
    `[bg] moved to background` notice, ...
```

**이후**:
```markdown
* 🕐 **`bg.ts` (Bash Background Runner)**: Long-running bash commands (downloads, builds)
  can be run in the background so the agent keeps working on other tasks.
  * **`/bg <command>`** — runs the command in the background and returns immediately.
    The command runs in its own process group; completion is auto-injected into the
    agent's message queue. Use `/bglist` to check status, `/bgkill <id>` to terminate.
  * **`ctrl+q`** — shows status of running `/bg` jobs (was: mid-execution backgrounding).
    For commands not started with `/bg`, shows a hint to use `/bg` instead.
  * **`# bg:quiet`** — append to a `/bg` command to suppress the completion notification.
  * **`# bg:run`** (agent path) — the model appends this marker to a bash command to
    background it; the tool call returns immediately and completion is auto-injected.
```

---

## 11. 리스크 및 미해결 질문

| 리스크 | 영향 | 완화 전략 |
|---|---|---|
| **R1**: 모델이 `# bg:run`을 깜빡하고 긴 명령 실행 (리뷰 개정 — 원 안의 "시스템 프롬프트에 `/bg` 가이드"는 모델이 슬래시 커맨드를 실행할 수 없어 무효) | 백그라운드 안 됨 → 응답 지연 | ① `# bg:run`은 bash 명령의 일부이므로 모델이 사용 가능 (G8) ② 시스템 프롬프트에 "10초 이상 걸릴 명령에는 `# bg:run`을 붙여라" 가이드 주입 (Q3) ③ 시간 휴리스틱 자동 opt-in은 Phase 4 후보 |
| **R2**: `detached: true`의 플랫폼 차이 | Windows에서 PGID 미생성 → 그룹 킬 실패 | N4로 Unix 전용 명시; Windows 사용자에게 WSL/Unix 안내 |
| **R3**: 기존 `/tmp/pi-bg/` 작업 (구 래퍼) | 신규 코드가 인식 못함 | `cmd`/`session` 읽을 때 base64 시도 + 평문 폴백; STALE_MS 후 자동 정리 |
| **R4**: `ctrl+q` 동작 변경에 대한 사용자 저항 | UX 회귀 체감 | README/릴리스 노트에 명확히 공지; Phase 1에서 두 동작 병렬 노출로 검증 기간 확보 |
| **R5**: `bgnow` 재작성 시 기존 사용자 스크립트 깨짐 | 자동화 워크플로우 중단 | §5.7 옵션 B로 하위 호환 + deprecation 경고 |
| **R6**: 동시 `/bg` 100개 이상 시 `fs.watch` 부담 | 이벤트 루프 과부하 | `hasInterest()` 가드로 sweep 빈도 조절 (기존 로직 유지) |
| **R7**: TUI 스트리밍 손실 (N1) | 백그라운드 명령 진행 상황 시각화 불가 | Phase 4에서 extension fs.watch + setWidget로 구현 (별도 계획) |

### 미해결 질문 (구현 전 결정 필요)

| # | 질문 | 제안 기본값 |
|---|---|---|
| Q1 | `bgnow` 제거 vs 재작성? | 재작성 (옵션 B) |
| Q2 | `PI_BG_OPT_IN` env var 사용? (리뷰 개정 R-11: settings.json 플래그 대신) | Phase 1/2에서만, Phase 3에서 제거(상시 opt-in) |
| Q3 | 시스템 프롬프트에 `# bg:run` 가이드 자동 주입? (리뷰 개정: `/bg`→`# bg:run`) | `before_agent_start` 훅으로 1줄 추가 — bash 툴로 실행되므로 유효 |
| Q4 | Phase 4 (스트리밍 widget) 언제? | 별도 RFC, 이번 redesign과 분리 |

---

## 12. 구현 순서 및 추정

| 단계 | 설명 | 추정 |
|---|---|---|
| **1** | `spawnBackground()` 함수 작성 + 타입 정의 | 1h |
| **2** | `/bgrun` 슬래시 커맨드 핸들러 작성 (Phase 2에서 `/bg` 승격) | 0.5h |
| **2b** | (리뷰 추가) `# bg:run` 마커 tool_call 재작성 로직 | 0.5h |
| **3** | `killJob()` PGID 기반으로 교체 | 0.5h |
| **4** | `ctrl+q` 핸들러를 "상태 표시" 버전으로 교체 | 0.5h |
| **5** | `bgCommandsRegistered` 조건부 등록 로직 제거 | 0.5h |
| **6** | `wrapCommand()` 함수 제거 (또는 export만 유지) | 0.5h |
| **7** | `tests/bg-redesign.test.mjs` 작성 | 2h |
| **8** | 기존 `tests/bg-regression.test.mjs` 회귀 검증 | 0.5h |
| **9** | `scripts/bgnow` 재작성 | 0.5h |
| **10** | README.md 업데이트 | 0.5h |
| **11** | 수동 통합 테스트 (체크리스트 §8.3) | 1h |
| **12** | Phase 1 배포 + 1주일 모니터링 | — |
| **13** | Phase 2 기본값 전환 | 0.5h |
| **14** | Phase 2 모니터링 (3일) | — |
| **15** | Phase 3 정리 (deprecated 코드 제거) | 0.5h |
| **총** | | **~9h + 1.5주 모니터링** |

---

## 13. 참고 자료

- **현재 코드**: `extensions/bg.ts` (604 lines)
- **현재 테스트**: `tests/bg-regression.test.mjs`
- **관련 커밋**:
  - `b03cc22 feat(bg): replace [bg notice] prompt-prepend with auto-injected completion message`
  - `0e1ece6 fix: scope bg jobs to owning session with explicit backgrounded marker`
  - `c0cba67 feat: expose /bg commands only when backgrounded jobs exist`
  - `572dd04 feat: add bash background runner extension (bg.ts) + bgnow helper`
  - `dc79e5e fix(bg): unref sweep timer & watcher; skip fs.watch on Linux (pi -p exit-hang fix)`
- **Node.js API**:
  - [`child_process.spawn()`](https://nodejs.org/api/child_process.html#child_processspawncommand-args-options) — `detached: true`로 PGID 생성
  - [`process.kill(pid, signal)`](https://nodejs.org/api/process.html#processkillpid-signal) — 음수 PID로 그룹 킬
- **Pi Extension API**: `@earendil-works/pi-coding-agent`의 `ExtensionAPI`, `registerCommand`, `registerShortcut`, `sendMessage`, `ctx.ui`

---

## 14. 승인 및 다음 단계

- [x] **Plan 리뷰**: 2026-08-19 코드 대조 리뷰 (v2, D1+R-1~R-11) + v2.1 사소한 이슈 3개 패치
- [ ] **Q1-Q4 결정**: Q1(`bgnow` 재작성 — Phase 3 직전 필요), Q3(프롬프트 가이드) 미결정. Q2는 R-11로 `PI_BG_OPT_IN` 확정, Q4는 분리 확정
- [x] **Phase 1 구현**: 2026-08-20 — `spawnBackground()` + `/bgrun` + `# bg:run` 마커 (구 래핑 경로 병렬 유지)
  - 구현 중 발견·수정: 명령이 `exit N`을 호출하면 스크립트 자체도 종료돼 exit 파일 미기록 → **명령을 서브셸에서 eval** `( eval ... )`
- [x] **Phase 2 구현**: 2026-08-20 (사용자 지시로 모니터링 대기 없이 바로 진행) — `wrapCommand()` 호출 제거·무래핑 통과(G4), `/bgrun`→`/bg` 승격, `ctrl+q` 상태표시화, `/bg`·`/bglist`·`/bgkill` 항상 등록, `bgCommandsRegistered`·`tryBackground`·`input`/`tool_execution_end` 게이트 로직 제거
- [x] **Phase 3 구현**: 2026-08-20 — `wrapCommand()`·`# bg:off`·`PI_BG_OPT_IN` 완전 제거, `killJob` R-8 폴백 순서(-jobPid→-wrapperPid→jobPid) + R-9 `.unref()`, `scripts/bgnow` 옵션 B 재작성(list/status/kill, 구형식 호출은 deprecation 경고 후 status 폴백 — 실동작 검증 완료), 구 회귀 테스트 물리 삭제
- [x] **테스트 통과**: `tests/bg-redesign.test.mjs` 10/10 (PGID 격리·그룹 킬·exit code·다중 라인·자동 주입·quiet·`/bg` 무조건 등록·무래핑 통과·ctrl+q 상태표시·고아 tail 없음)
- [ ] **수동 검증**: TUI 실동작 (`/bg` 실제 사용, `pi -p` 종료 확인) + 실사용 모니터링 → Phase 4(RFC) 결정

> **Q1 결정 (2026-08-20)**: `bgnow` **옵션 B(재작성) 채택** — list/status/kill 상태 조회 전용, 구형식 호환 폴백 포함.

**리뷰 후 수정 사항은 본 문서에 직접 반영 (체크박스 + 변경 이력 섹션 추가)**.

---

## 15. 변경 이력 — 2026-08-19 코드 대조 리뷰 반영

`extensions/bg.ts`(604줄)·`tests/bg-regression.test.mjs`·`scripts/bgnow`·`install.sh`와
대조한 리뷰 결과 반영. 각 항목의 **수정 이유**를 함께 기록한다.

| ID | 위치 | 수정 내용 | 수정 이유 (리뷰 근거) |
|---|---|---|---|
| **D1** | §1.2, §2 | 래퍼 패치(안 a) vs redesign(안 b) 의결 → **안 b 채택** + 에이전트 경로는 마커로 복원 | 5종 패치라도 60+줄 래퍼·tail·SIGUSR1 race가 남아 유지보수 부담이 크고, mid-execution 전환은 시작 시점 opt-in으로 대체 가능. 다만 redesign이 에이전트 백그라운딩 경로를 소실시키므로 G8으로 복원 |
| **R-1** | §4, §5.1, §5.8, §11(R1/Q3) | `# bg:run` 마커 추가 (G8) | **결정적 문제**: 모델은 슬래시 커맨드를 실행할 수 없어 `/bg`만으로는 에이전트가 자기 긴 명령을 백그라운딩할 수 없음 → 긴 명령 시나리오에서 ①턴 블로킹 ②완료 자동 통지 두 가지 모두 소실. 원 안의 R1 완화("시스템 프롬프트에 `/bg` 가이드")는 구조적으로 무효. 마커는 bash 명령의 일부이므로 모델이 사용 가능하고 기본 무래핑(G4)도 유지 |
| **R-3** | §7 Phase 1/2 | Phase 1 신규 커맨드를 `/bgrun`으로 분리, Phase 2에서 `/bg` 승격 | 기존 `/bg [id]`(실행 중 작업 전환)와 이름 충돌 — 같은 이름에 두 의미를 `registerCommand`로 등록할 수 없어 Phase 1 병렬 배포가 불가했던 blocker |
| **R-4** | §5.1 | 명령 임베드를 `eval ${JSON.stringify(cmd)}` → **cmd 파일 기록 + `eval "$(cat ...)"`** | bash 이중인쇄 문자열은 JSON 이스케이프를 해석하지 않아 `\n`이 리터럴로 남고 다중 라인 명령이 깨짐. 원 안의 "JSON.stringify로 줄바꿈 안전 처리" 주장은 오해 |
| **R-5** | §5.1 | spawn 후 `closeSync(logFd)` 추가 | 부모가 log fd를 닫지 않으면 job 수만큼 pi 프로세스 fd가 영구 점유 (fd 누출) |
| **R-6** | §8.2 | "기존 테스트가 그대로 통과" → 페이즈별 폐기/대체 표 | 기존 회귀 테스트가 래핑+SIGUSR1 플로우를 직접 검증하므로 Phase 2/3에서 그대로 통과는 불가능 — 원 안의 자기 모순 |
| **R-7** | §6 | "cmd/session 이전: base64" → "평문(래퍼가 디코드 후 기록)" 정정, base64 마이그레이션 제거 | 현행 래퍼 코드가 base64를 디코드한 뒤 평문으로 기록함을 확인 — 마이그레이션 로직 불필요. 실제 전환기 이슈는 `pid` 파일 의미 변화뿐 |
| **R-8** | §5.4 | `killJob` 폴백 순서 `-jobPid` → `-wrapperPid` → `jobPid` | 전환기에 실행 중인 **구 형식 job**의 PGID 리더는 wrapper이므로 `-jobPid`만으로는 그룹 킬 불가 (ESRCH → 개별 PID 폴백으로 자식 프로세스 생존) |
| **R-9** | §5.4 | SIGKILL 에스컬레이션 `setTimeout().unref()` | `pi -p`(원샷)에서 kill 호출 시 타이머만으로 프로세스가 2s 더 생존 — G7 회귀. (호스트가 먼저 종료하면 에스컬레이션 미수행은 허용, 문서화) |
| **R-10** | §4 | 완료 감지의 Linux 폴링 전용 명시 | dc79e5e: Linux/Node 22에서 `FSWatcher.unref()` 무효 → Linux는 `fs.watch` 미사용. 다이어그램의 `fs.watch`만 보고 구현하면 G7 회귀 |
| **R-11** | §5.9, §7 | settings.json `bg.useOptIn` → `PI_BG_OPT_IN` env var | extension은 현재 env var(`PI_BG_*`)만 읽고 settings 읽기 메커니즘이 없음 — 기존 패턴 통일, 미기재 의존 제거 |

### 15.2 구현 이력 — 2026-08-20 Phase 1~3 일괄 구현

사용자 지시로 Phase 1 모니터링 대기 없이 Phase 2·3까지 연속 구현.

| 페이즈 | 내용 | 비고 |
|---|---|---|
| Phase 1 | `spawnBackground()` + `/bgrun` + `# bg:run` 마커 (병렬 배포) | 커밋 `838d8b0` |
| Phase 2 | 무래핑 통과(G4), `/bg` 승격, `ctrl+q` 상태표시, 항상 등록, 게이트 로직 제거 | `PI_BG_OPT_IN` 게이트는 Phase 3에서 함께 제거되므로 건너뜀 |
| Phase 3 | `wrapCommand`·`# bg:off` 완전 제거, `killJob` R-8/R-9, `bgnow` 옵션 B 재작성, 구 회귀 테스트 삭제 | Q1 = 옵션 B 채택 |

**구현 중 발견·반영한 추가 수정**:
- 명령이 `exit N`을 호출하면 스크립트(부모 bash) 자체가 종료돼 exit 파일 미기록 → 명령을 **서브셸에서 eval** `( eval "$(cat ...)" )`
- `PI_BG_STALE_MS` env var 신규 (플랜 §5.9 예고분, 하드코딩 24h → 오버라이드 가능)
- `bgnow` kill은 SIGTERM만 전달 (SIGKILL 에스컬레이션은 pi `/bgkill` 전용 — 스크립트 헤더에 명시)

**검증**: `tests/bg-redesign.test.mjs` 10/10 · `bgnow` list/status/kill/구형식 호환 실동작 확인
**남은 것**: TUI 실동작 수동 검증 + 실사용 모니터링 (Phase 4 RFC 결정 전제)

### 15.1 v2.1 패치 — 2026-08-19 사소한 이슈 3개

v2 리뷰에서 발견된 비-결정적 이슈 3건. 각 항목은 **문서 일관성/명료성** 개선이며 설계 변경 없음.

| ID | 위치 | 수정 내용 | 수정 이유 |
|---|---|---|---|
| **v2.1-A** | §5.1, §15 | `# bg:run` tool_call 핸들러의 echo 메시지 `"[bg] moved to background ..."` → `"[bg] started in background ..."` | `# bg:run`은 **실행 전** 백그라운딩(opt-in 마커)이고, "moved to"는 mid-execution 전환(구 ctrl+q)의 표현 — 의미 혼동 방지 |
| **v2.1-B** | §5.1 | tool_call 스니펫에 `const QUIET_MARKER = "# bg:quiet"` 정의 추가 | 스니펫이 `cmd.includes(QUIET_MARKER)`를 참조하지만 정의 라인이 빠져 있었음 — 스니펫만 복사하면 컴파일 실패 |
| **v2.1-C** | §4 | 완료 감지 다이어그램에 `(macOS: fs.watch 즉시 / Linux: 5s polling sweep)` 명시 | R-10 노트는 있었지만 다이어그램 자체에 플랫폼 분기 표시 없음 — 다이어그램만 보고 구현하면 G7 회귀 위험 |

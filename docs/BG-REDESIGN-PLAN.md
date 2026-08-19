# 🛠 bg.ts Architectural Redesign — Implementation Plan

> **Status**: Draft for review · **Author**: custom-pi maintainers · **Created**: 2026-08-19 (KST)
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

### 2.2 비목표 (Non-Goals)

| ID | 비목표 |
|---|---|
| **N1** | 백그라운드 명령의 실시간 TUI 스트리밍 (deferred — 후속 enhancement) |
| **N2** | `ctrl+q`가 non-`/bg` 명령에 동작 (의도된 동작 변경) |
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
```

**핵심 변화**:
- **래퍼 스크립트 제거** — Extension이 Node.js `spawn`으로 직접 명령 실행
- **tail 제거** — 로그 스트리밍은 extension의 `fs.watch` + `readFile`로 (필요 시)
- **opt-in 명시화** — `/bg <cmd>`만 래핑, 나머지는 통과
- **`detached: true`** — Node.js가 Unix에서 자동으로 새 process group 생성 (`setsid` 불필요)


---

## 5. 상세 컴포넌트 설계

### 5.1 Extension 측: `/bg` 슬래시 커맨드

**파일**: `extensions/bg.ts`

```typescript
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, openSync } from "node:fs";

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

    // 작업 스크립트 — eval + exit code 기록만 (최소)
    // JSON.stringify로 명령 내 따옴표/줄바꿈 안전 처리
    const jobScript = [
        `set +e`,
        `eval ${JSON.stringify(cmd)}`,
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

**`tool_call` 핸들러 변경**:

```typescript
// 이전: 모든 bash 명령을 wrapCommand()로 래핑
// 이후: 래핑 안 함 — 통과시킴
pi.on("tool_call", (event, ctx) => {
    // 의도적으로 비워둠. /bg로 시작된 명령만 래핑됨.
    // (향후 opt-out 마커가 필요한 경우 여기에 추가)
});
```

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
    try {
        // detached:true로 spawn된 작업은 자체 PGID 리더
        // → -PID로 그룹 단위 종료 (자식 프로세스 포함)
        process.kill(-j.jobPid, "SIGTERM");
    } catch (e) {
        // PGID 킬 실패 시 개별 PID로 폴백
        try {
            process.kill(j.jobPid, "SIGTERM");
        } catch {
            return false;
        }
    }
    // 2초 후에도 살아있으면 SIGKILL
    setTimeout(() => {
        if (isAlive(j.jobPid)) {
            try { process.kill(-j.jobPid, "SIGKILL"); }
            catch { try { process.kill(j.jobPid, "SIGKILL"); } catch {} }
        }
    }, 2000);
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

### 5.8 `# bg:off` / `# bg:on` 마커 — 제거

- `# bg:off`: 무조건 래핑이 없어졌으므로 무의미. **제거**.
- `# bg:on`: opt-in이 슬래시 커맨드로 명시화되었으므로 무의미. **제거**.
- `# bg:quiet`: 유지 (통지 억제 용도로 여전히 유용).

### 5.9 환경 변수 정리

| 변수 | 이전 | 이후 |
|---|---|---|
| `PI_BG_DIR` | 유지 | 유지 (기본 `/tmp/pi-bg`) |
| `PI_BG_SWEEP_MS` | 유지 | 유지 (폴링 간격, 기본 5000) |
| `PI_BG_DEBOUNCE_MS` | 유지 | 유지 (배치 디바운스, 기본 1500) |
| `PI_BG_STALE_MS` | (없음, 하드코딩 24h) | 신규 — STALE_MS 오버라이드 |

---

## 6. 데이터 모델 및 파일 레이아웃

`/tmp/pi-bg/<jobid>/`:

| 파일 | 내용 | 이전 | 이후 |
|---|---|---|---|
| `pid` | PID | 래퍼 PID | 작업 bash PID (= jobpid) |
| `jobpid` | 작업 PID | 작업 PID | 작업 bash PID |
| `cmd` | 원본 명령 | base64 | 평문 (Node.js spawn이 안전 처리) |
| `session` | Pi 세션 ID | base64 | 평문 |
| `log` | stdout+stderr | wrapper가 작성 | Node.js가 직접 작성 |
| `exit` | 종료 코드 | 작업이 작성 | 작업이 작성 (변경 없음) |
| `backgrounded` | 백그라운드 마커 | ctrl+q 시 작성 | 항상 존재 |
| `notified` | 통지 마커 | extension이 작성 | (변경 없음) |
| `quiet` | 통지 억제 | (조건부) | (조건부, 변경 없음) |

**하위 호환**: 기존 작업의 `cmd`/`session`이 base64 형식이어도 `readFile`로 읽고 base64 디코드 시도, 실패 시 평문으로 폴백.


---

## 7. 마이그레이션 경로

### Phase 1: 병렬 배포 (1주일 검증)

**목표**: 기존 동작 유지하면서 `/bg` 경로 추가

**변경사항**:
1. `extensions/bg.ts`에 `spawnBackground()` + `/bg` 핸들러 추가
2. 기존 `wrapCommand()` + `tool_call` 핸들러는 **그대로 유지**
3. `settings.json.example`에 `"bg": { "useOptIn": false }` 추가 (기본: 기존 동작)
4. README에 `/bg` 사용법 추가 (기존 ctrl+q 동작은 유지)

**검증 항목**:
- [ ] `/bg sleep 5 && echo done` → 즉시 반환, 5초 후 자동 통지
- [ ] 기존 ctrl+q 동작 그대로 (모든 bash 명령 백그라운드 전환)
- [ ] `pi -p` 모드 정상 종료

### Phase 2: 기본값 전환 (Phase 1 검증 후)

**목표**: `useOptIn: true`가 기본값. 무조건 래핑 제거.

**변경사항**:
1. `settings.json.example`의 `"bg.useOptIn": true`로 변경
2. `tool_call` 핸들러에서 `wrapCommand()` 호출 제거 (단, `wrapCommand` 함수는 export 유지 — 롤백용)
3. `ctrl+q` 핸들러를 §5.2의 "상태 표시" 버전으로 교체
4. README에서 ctrl+q의 "백그라운드 전환" 설명을 "상태 표시"로 변경
5. `bgCommandsRegistered` 조건부 등록 로직 제거

**검증 항목**:
- [ ] Phase 1의 모든 검증 항목
- [ ] 단순 `echo hi`가 래핑 없이 즉시 실행 (오버헤드 제거 확인)
- [ ] `pkill -f 'tail.*pi-bg'` 실행 시 자기 재귀 없음
- [ ] 다음 명령 출력에 이전 tail 에러 없음 (오염 제거 확인)

### Phase 3: 정리 (Phase 2 안정화 후)

**목표**: deprecated 코드 제거

**변경사항**:
1. `wrapCommand()` 함수 완전 제거
2. `# bg:off` / `# bg:on` 마커 처리 코드 제거
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

### 8.2 회귀 테스트 (`tests/bg-regression.test.mjs` 기존)

기존 테스트가 **그대로 통과**해야 함 (하위 호환 검증):
- `wrapCommand()` 제거 후에도 기존 export (`sweep`) 동작
- `/tmp/pi-bg/<jobid>/` 디렉토리 스캔 로직 변경 없음
- 완료 자동 주입 (`flushNotices`) 변경 없음

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
| Phase 1 | `settings.json`에서 `"bg.useOptIn": false` 설정 → 기존 무조건 래핑 복귀 |
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
```

---

## 11. 리스크 및 미해결 질문

| 리스크 | 영향 | 완화 전략 |
|---|---|---|
| **R1**: 모델이 `/bg`를 깜빡하고 긴 명령 실행 | 백그라운드 안 됨 → 응답 지연 | 시스템 프롬프트에 `/bg` 사용 가이드 추가; 시간 휴리스틱(예: 10s 이상) 자동 opt-in (Phase 4) |
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
| Q2 | `settings.json`에 `bg.useOptIn` 플래그 추가? | Phase 1에서만, Phase 3에서 제거 |
| Q3 | 시스템 프롬프트에 `/bg` 가이드 자동 주입? | `before_agent_start` 훅으로 1줄 추가 |
| Q4 | Phase 4 (스트리밍 widget) 언제? | 별도 RFC, 이번 redesign과 분리 |

---

## 12. 구현 순서 및 추정

| 단계 | 설명 | 추정 |
|---|---|---|
| **1** | `spawnBackground()` 함수 작성 + 타입 정의 | 1h |
| **2** | `/bg` 슬래시 커맨드 핸들러 작성 | 0.5h |
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
| **총** | | **~8.5h + 1.5주 모니터링** |

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

- [ ] **Plan 리뷰**: 위 설계에 대한 피드백
- [ ] **Q1-Q4 결정**: §11 미해결 질문 답변
- [ ] **Phase 1 구현 시작**: §12 순서대로 진행
- [ ] **테스트 통과 확인**: §8 체크리스트 완료 후 Phase 2 진행

**리뷰 후 수정 사항은 본 문서에 직접 반영 (체크박스 + 변경 이력 섹션 추가)**.

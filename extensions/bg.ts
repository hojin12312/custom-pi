/**
 * bg.ts — Bash 백그라운드 전환 확장 (수동 /bg, passive 통지)
 *
 * 목적: 긴 bash 작업(다운로드 등)을 백그라운드에 두고, 에이전트와 다른 작업을
 * 계속 진행하기 위함. 자동 백그라운드(예: 10초)는 의도적으로 제외 — 사용자가
 * 명시적으로 /bg 로만 전환한다.
 *
 * 동작:
 *  1. 모든 LLM bash 툴 콜을 래퍼로 감싼다. 래퍼는 실제 명령을 서브셸로 실행하되
 *     출력을 /tmp/pi-bg/<jobid>/log 파일로 보내고 tail -f 로 TUI 스트리밍을 유지한다.
 *     (pi의 bash 툴은 원래 stdin이 /dev/null 이므로, 백그라운드 전환으로 인한
 *      stdin 손실은 없음 — spawn 시 stdio[0]="ignore")
 *  2. ctrl+q (단축키) — 실행 중인 (가장 최근) 작업에 SIGUSR1 을 보내 백그라운드 전환.
 *     래퍼는 대기를 풀고 "(bg) moved to background" 를 반환 → 툴 콜이
 *     즉시 끝나 에이전트 턴이 계속 진행된다. 실제 작업은 로그 파일로 계속 실행된다.
 *     ⚠️ 슬래시 커맨드(/bg)는 툴 실행 중 타이핑하면 pi가 입력을 큐잉했다가
 *     툴이 끝난 뒤에 전달하므로 실행 중 전환에는 쓸 수 없다 (2026-08-07 실측).
 *     따라서 실행 중 전환의 주 경로는 ctrl+q 단축키 + 외부 bgnow 스크립트.
 *  3. /bg [id] — 동일 동작의 슬래시 커맨드
 *  4. /bglist   — 작업 상태 목록 (running/done, exit code, cmd 요약, log 경로)
 *  5. /bgkill <id|all> — 작업 프로세스 그룹 종료 (SIGTERM → SIGKILL)
 *     ⚠️ /bg·/bglist·/bgkill 은 실제로 백그라운드된 살아있는 프로세스가 있을 때만
 *     등록·노출된다 (세션 시작 시 잔여 작업, 첫 백그라운드 전환 시점). 미등록 상태에서
 *     타이핑하면 비활성 안내만 한다. pi에 커맨드 언레지스터가 없어 최초 등록 후에는
 *     세션 동안 유지되며, /reload 시 재평가된다.
 *     각 작업에는 소유 Pi session id를 기록하고, 정상 포그라운드 완료 시 임시 기록을
 *     제거한다. ctrl+q/SIGUSR1 전환 때만 backgrounded 표식을 남긴다.
 *  6. passive 통지: 작업을 시작한 동일 세션의 다음 유저 프롬프트(input, source=interactive)에
 *     - 완료된 작업(아직 통지 안 한 것만, 1회): "작업 <id> 완료 (exit N) + 로그 tail"
 *     - 실행 중인 작업: "작업 <id> 실행 중 (cmd 요약, log 경로)"
 *     을 사용자 메시지 앞에 삽입한다. 완료 즉시 턴을 만들지 않는다 (방해 금지).
 *     완료 판별: 래퍼가 작업 종료 시 $DIR/exit 파일에 exit code를 기록.
 *
 * opt-out: 에이전트가 특정 명령을 래핑에서 제외하려면 명령 안에 `# bg:off` 포함.
 *
 * 롤백: 이 파일을 ~/.pi/agent/extensions/ 에서 제거하고 /reload 하면 끝.
 *       이미 백그라운드로 보낸 작업은 계속 실행되며(고아), 통지만 끊긴다.
 *       정리: rm -rf /tmp/pi-bg
 */

import { readdirSync, readFileSync, statSync, writeFileSync, existsSync, rmSync, openSync, fstatSync, readSync, closeSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const BG_DIR = process.env.PI_BG_DIR?.trim() || "/tmp/pi-bg";
const BG_OFF_MARKER = "# bg:off";
const STALE_MS = 24 * 60 * 60 * 1000; // 완료/유실 작업 디렉토리 보존 후 정리

// ---------------------------------------------------------------------------
// 래퍼 (bash). 원본 명령은 base64 로 임베드해서 따옴표/줄바꿈 이슈를 회피한다.
// ---------------------------------------------------------------------------
function wrapCommand(original: string, sessionId: string): string {
	const b64 = Buffer.from(original, "utf8").toString("base64");
	const sessionB64 = Buffer.from(sessionId, "utf8").toString("base64");
	return [
		`set +e`,
		`JOBID="$$-$(date +%s)"`,
		`DIR="${BG_DIR}/$JOBID"`,
		`mkdir -p "$DIR"`,
		`LOG="$DIR/log"`,
		`echo "$$" > "$DIR/pid"`,
		`B64DEC="base64 -D"`,
		`if printf 'aGk=' | base64 -d >/dev/null 2>&1; then B64DEC="base64 -d"; fi`,
		`printf '%s' '${b64}' | $B64DEC > "$DIR/cmd" 2>/dev/null`,
		`printf '%s' '${sessionB64}' | $B64DEC > "$DIR/session" 2>/dev/null`,
		`BG=0`,
		`trap 'BG=1; : > "$DIR/backgrounded"' USR1`,
		`{ eval "$(cat "$DIR/cmd")"; C=$?; echo "$C" > "$DIR/exit"; exit $C; } >"$LOG" 2>&1 &`,
		`JOBPID=$!`,
		`echo "$JOBPID" > "$DIR/jobpid"`,
		`tail -n +1 -f "$LOG" &`,
		`TAILPID=$!`,
		`while kill -0 "$JOBPID" 2>/dev/null; do`,
		`  if [ "$BG" = "1" ] && kill -0 "$JOBPID" 2>/dev/null; then`,
		`    echo ""`,
		`    echo "[bg] moved to background job=$JOBID log=$LOG (완료 시 다음 프롬프트에서 통지됩니다)"`,
		`    kill "$TAILPID" 2>/dev/null`,
		`    exit 0`,
		`  fi`,
		`  sleep 0.5`,
		`done`,
		`kill "$TAILPID" 2>/dev/null`,
		`wait "$JOBPID" 2>/dev/null`,
		`CODE=$?`,
		`echo "[done] exit=$CODE" >&2`,
		`if [ ! -e "$DIR/backgrounded" ]; then rm -rf "$DIR"; fi`,
		`exit $CODE`,
	].join("\n");
}

// ---------------------------------------------------------------------------
// 작업 스캔
// ---------------------------------------------------------------------------
interface JobInfo {
	id: string;
	dir: string;
	wrapperPid: number;
	jobPid: number;
	cmd: string;
	started: number;
	logPath: string;
	status: "running" | "done" | "gone";
	exitCode?: number;
	wrapperAlive: boolean;
	sessionId: string;
	backgrounded: boolean;
}

function readInt(path: string): number {
	try {
		const n = parseInt(readFileSync(path, "utf8").trim(), 10);
		return Number.isFinite(n) ? n : 0;
	} catch {
		return 0;
	}
}

function isAlive(pid: number): boolean {
	if (!pid || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		return (e as NodeJS.ErrnoException).code === "EPERM";
	}
}

function readTailFile(path: string, maxBytes = 8192): string {
	try {
		const fd = openSync(path, "r");
		try {
			const size = fstatSync(fd).size;
			const len = Math.min(size, maxBytes);
			const buf = Buffer.alloc(len);
			readSync(fd, buf, 0, len, size - len);
			return buf.toString("utf8");
		} finally {
			closeSync(fd);
		}
	} catch {
		return "";
	}
}

function lastLines(s: string, n: number): string {
	return s.split("\n").slice(-n).join("\n").trim();
}

function cmdSummary(cmd: string, max = 70): string {
	const one = cmd.replace(/\s+/g, " ").trim();
	return one.length > max ? one.slice(0, max - 1) + "…" : one;
}

function scanJobs(): JobInfo[] {
	let entries: string[];
	try {
		entries = readdirSync(BG_DIR);
	} catch {
		return [];
	}
	const now = Date.now();
	const jobs: JobInfo[] = [];
	for (const id of entries) {
		const dir = join(BG_DIR, id);
		let st: ReturnType<typeof statSync>;
		try {
			st = statSync(dir);
		} catch {
			continue;
		}
		if (!st.isDirectory()) continue;
		const logPath = join(dir, "log");
		const exitPath = join(dir, "exit");
		const wrapperPid = readInt(join(dir, "pid"));
		const jobPid = readInt(join(dir, "jobpid"));
		let cmd = "";
		try {
			cmd = readFileSync(join(dir, "cmd"), "utf8");
		} catch {
			/* cmd 파일이 아직 없을 수 있음 */
		}
		let sessionId = "";
		try {
			sessionId = readFileSync(join(dir, "session"), "utf8").trim();
		} catch {
			/* 구버전 작업에는 session 파일이 없음 */
		}
		const backgrounded = existsSync(join(dir, "backgrounded"));

		let status: JobInfo["status"];
		let exitCode: number | undefined;
		if (existsSync(exitPath)) {
			status = "done";
			exitCode = readInt(exitPath);
		} else if (isAlive(jobPid)) {
			status = "running";
		} else {
			status = "gone";
		}

		// 오래된 완료/유실 디렉토리 정리 (running 은 절대 건드리지 않음)
		if (status !== "running" && now - st.mtimeMs > STALE_MS) {
			try {
				rmSync(dir, { recursive: true, force: true });
			} catch {
				/* ignore */
			}
			continue;
		}

		jobs.push({
			id,
			dir,
			wrapperPid,
			jobPid,
			cmd,
			started: st.mtimeMs,
			logPath,
			status,
			exitCode,
			wrapperAlive: isAlive(wrapperPid),
			sessionId,
			backgrounded,
		});
	}
	return jobs;
}

function killJob(j: JobInfo): boolean {
	if (!isAlive(j.jobPid)) return false;
	// 래퍼 쉘(그룹 리더)의 프로세스 그룹으로 킬 → 작업 + 자식 전부
	try {
		process.kill(-j.wrapperPid, "SIGTERM");
	} catch {
		try {
			process.kill(j.jobPid, "SIGTERM");
		} catch {
			return false;
		}
	}
	// 유예 후에도 살아있으면 SIGKILL
	setTimeout(() => {
		if (isAlive(j.jobPid)) {
			try {
				process.kill(-j.wrapperPid, "SIGKILL");
			} catch {
				try {
					process.kill(j.jobPid, "SIGKILL");
				} catch {
					/* ignore */
				}
			}
		}
	}, 2000);
	return true;
}

// ---------------------------------------------------------------------------
// 백그라운드 전환 공통 로직 (단축키 + /bg 커맨드 공유)
// ---------------------------------------------------------------------------
function tryBackground(sessionId: string, arg?: string): { ok: boolean; message: string } {
	const active = scanJobs().filter(
		(j) => j.sessionId === sessionId && j.status === "running" && j.wrapperAlive && !j.backgrounded,
	);
	if (active.length === 0) {
		return { ok: false, message: "백그라운드로 보낼 실행 중인 작업이 없습니다" };
	}
	let target: JobInfo;
	if (arg && arg.trim()) {
		const byId = active.find((j) => j.id === arg.trim());
		if (!byId) {
			return { ok: false, message: `작업 ${arg.trim()} 을(를) 찾을 수 없습니다 (실행 중 아님)` };
		}
		target = byId;
	} else {
		target = active.sort((a, b) => b.started - a.started)[0];
	}
	try {
		process.kill(target.wrapperPid, "SIGUSR1");
	} catch (e) {
		return { ok: false, message: `전환 실패: ${(e as Error).message}` };
	}
	// 래퍼의 USR1 trap도 같은 표식을 쓰지만, 신호 전달 성공 직후 기록해
	// 매우 짧은 작업의 종료 race에서도 전환 사실을 보존한다.
	try {
		writeFileSync(join(target.dir, "backgrounded"), "1");
	} catch {
		/* trap이 표식을 기록하므로 신호 전달 성공 자체는 유지 */
	}
	return { ok: true, message: `작업 ${target.id} 를 백그라운드로 전환했습니다 (log: ${target.logPath})` };
}

// ---------------------------------------------------------------------------
// 조건부 커맨드 등록
// 실제로 백그라운드로 전환된 살아있는 프로세스가 있을 때만 /bg 계열을 노출한다.
// (pi API에 커맨드 언레지스터가 없어, 최초 등록 후에는 세션 동안 유지된다.
//  메뉴 갱신은 identity autocomplete wrapper로 트리거한다.)
// ---------------------------------------------------------------------------
let bgCommandsRegistered = false;

/** "남아있는 bg 프로세스": 래퍼가 빠지고(wrapperAlive=false) 작업이 살아있는 상태 */
function hasBackgroundedJob(sessionId: string): boolean {
	return scanJobs().some(
		(j) => j.sessionId === sessionId && j.backgrounded && j.status === "running" && !j.wrapperAlive,
	);
}

interface AutocompleteUi {
	addAutocompleteProvider(f: (current: unknown) => unknown): void;
}

function registerBgCommands(pi: ExtensionAPI, ui?: AutocompleteUi): void {
	if (bgCommandsRegistered) return;
	bgCommandsRegistered = true;

	pi.registerCommand("bg", {
		description: "Send the running bash command to background (usage: /bg [jobid]; 단축키 ctrl+q 권장)",
		handler: async (args, ctx) => {
			const r = tryBackground(ctx.sessionManager.getSessionId(), args);
			ctx.ui.notify(r.message, r.ok ? "info" : "warning");
		},
	});

	pi.registerCommand("bglist", {
		description: "List background jobs",
		handler: async (_args, ctx) => {
			const sessionId = ctx.sessionManager.getSessionId();
			const jobs = scanJobs().filter((j) => j.sessionId === sessionId && j.backgrounded);
			if (jobs.length === 0) {
				ctx.ui.notify("백그라운드 작업 없음", "info");
				return;
			}
			const lines = jobs.map((j) => {
				const icon = j.status === "running" ? "⏳" : j.status === "done" ? (j.exitCode === 0 ? "✓" : "✗") : "💀";
				const started = new Date(j.started).toLocaleTimeString("ko-KR", { hour12: false });
				const exit = j.status === "done" ? ` exit=${j.exitCode}` : "";
				const bg = !j.wrapperAlive && j.status === "running" ? " [bg]" : "";
				return `${icon} ${j.id}  ${started}  ${j.status}${exit}${bg}  ${cmdSummary(j.cmd, 60)}\n    log: ${j.logPath}`;
			});
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	pi.registerCommand("bgkill", {
		description: "Kill a background job (usage: /bgkill <jobid|all>)",
		handler: async (args, ctx) => {
			const arg = (args ?? "").trim();
			if (!arg) {
				ctx.ui.notify("사용법: /bgkill <jobid|all>", "warning");
				return;
			}
			const sessionId = ctx.sessionManager.getSessionId();
			const jobs = scanJobs().filter(
				(j) => j.sessionId === sessionId && j.backgrounded && j.status !== "gone",
			);
			const targets = arg === "all" ? jobs : jobs.filter((j) => j.id === arg);
			if (targets.length === 0) {
				ctx.ui.notify(`종료할 작업이 없습니다: ${arg}`, "warning");
				return;
			}
			for (const j of targets) {
				const killed = killJob(j);
				ctx.ui.notify(
					killed
						? `작업 ${j.id} 종료 요청 (log: ${j.logPath})`
						: `작업 ${j.id} 는 이미 종료되었습니다`,
					killed ? "info" : "warning",
				);
			}
		},
	});

	// 커맨드 등록 직후 자동완성 메뉴를 재빌드해 새 커맨드를 즉시 노출 (identity wrapper)
	ui?.addAutocompleteProvider((current) => current);
}

// ---------------------------------------------------------------------------
// 툴 콜 래핑
// ---------------------------------------------------------------------------
export default function (pi: ExtensionAPI) {
	pi.on("tool_call", (event, ctx) => {
		if (event.toolName !== "bash" || typeof event.input.command !== "string") return;
		const cmd = event.input.command;
		if (cmd.includes(BG_OFF_MARKER)) {
			event.input.command = cmd.split(BG_OFF_MARKER).join("");
			return;
		}
		event.input.command = wrapCommand(cmd, ctx.sessionManager.getSessionId());
	});

	// -----------------------------------------------------------------------
	// ctrl+q — 실행 중인 bash 명령을 백그라운드로 전환 (주 경로)
	// 툴 실행 중 타이핑은 큐잉되지만 단축키는 키 레벨에서 즉시 처리된다.
	// -----------------------------------------------------------------------
	pi.registerShortcut("ctrl+q", {
		description: "Send the running bash command to background",
		handler: async (ctx) => {
			const r = tryBackground(ctx.sessionManager.getSessionId());
			if (r.ok) registerBgCommands(pi, ctx.ui);
			ctx.ui.notify(`[bg-s] ${r.message}`, r.ok ? "info" : "warning");
		},
	});

	// -----------------------------------------------------------------------
	// /bg 계열 커맨드 노출 조건:
	//  - 세션 시작 시 잔여 백그라운드 프로세스가 있으면 등록
	//  - bash 툴 콜이 백그라운드 상태로 종료되면 등록 (ctrl+q/bgnow 등 외부 경로 포함)
	//  - input 핸들러에서 백그라운드 작업 발견 시에도 등록
	// -----------------------------------------------------------------------
	pi.on("session_start", (event, ctx) => {
		if (hasBackgroundedJob(ctx.sessionManager.getSessionId())) registerBgCommands(pi, ctx.ui);
	});

	pi.on("tool_execution_end", (event, ctx) => {
		if (event.toolName === "bash" && hasBackgroundedJob(ctx.sessionManager.getSessionId())) {
			registerBgCommands(pi, ctx.ui);
		}
	});

	// -----------------------------------------------------------------------
	// passive 통지 — 다음 유저 프롬프트에 작업 상태 삽입 (+ 미등록 /bg* 폴백)
	// -----------------------------------------------------------------------
	pi.on("input", (event, ctx) => {
		if (event.source !== "interactive") return { action: "continue" };
		if (!event.text || !event.text.trim()) return { action: "continue" };
		const text = event.text.trim();

		// 미등록 상태에서 /bg 계열 타이핑 → 작업이 없어 비활성화 상태임을 안내
		if (
			!bgCommandsRegistered &&
			(text === "/bg" ||
				text.startsWith("/bg ") ||
				text === "/bglist" ||
				text.startsWith("/bglist ") ||
				text === "/bgkill" ||
				text.startsWith("/bgkill "))
		) {
			ctx.ui.notify("백그라운드 작업이 없어 /bg 계열 명령이 비활성화되어 있습니다", "warning");
			return { action: "handled" };
		}

		const sessionId = ctx.sessionManager.getSessionId();
		const jobs = scanJobs().filter((j) => j.sessionId === sessionId && j.backgrounded);
		if (hasBackgroundedJob(sessionId)) registerBgCommands(pi, ctx.ui);
		const completed = jobs.filter((j) => j.status === "done" && !existsSync(join(j.dir, "notified")));
		const running = jobs.filter((j) => j.status === "running");
		if (completed.length === 0 && running.length === 0) return { action: "continue" };

		const lines: string[] = ["[bg notice]"];
		for (const j of completed) {
			lines.push(`- 백그라운드 작업 ${j.id} 완료 (exit ${j.exitCode ?? "?"}):`);
			const tail = lastLines(readTailFile(j.logPath), 6);
			if (tail) {
				for (const t of tail.split("\n")) lines.push(`    ${t}`);
			}
			try {
				writeFileSync(join(j.dir, "notified"), "1");
			} catch {
				/* ignore */
			}
		}
		for (const j of running) {
			lines.push(`- 백그라운드 작업 ${j.id} 실행 중: ${cmdSummary(j.cmd)} — log: ${j.logPath}`);
		}

		const notice = lines.join("\n");
		const transformed: { action: "transform"; text: string; images?: unknown } = {
			action: "transform",
			text: `${notice}\n\n${event.text}`,
		};
		if (event.images) transformed.images = event.images;
		return transformed;
	});
}

/**
 * bg-redesign.test.mjs — Phase 1 (docs/BG-REDESIGN-PLAN.md) 신규 경로 검증
 *
 *  - `# bg:run` 마커 (에이전트 경로, G8): tool_call 재작성 → detached bash spawn
 *  - /bgrun (사용자 경로): 무조건 등록, job 생성
 *  - PGID 격리 (detached:true), exit code 기록, 다중 라인 명령 (R-4)
 *  - 완료 자동 주입 재사용 (sweep, 세션 스코핑, 1회 보장), # bg:quiet
 *  - Phase 1 병렬 배포: 마커 없는 명령은 기존 래핑 그대로
 */
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";

async function waitFor(check, message, timeoutMs = 8000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const value = await check();
		if (value) return value;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error(`timeout: ${message}`);
}

function createHarness() {
	const handlers = new Map();
	const shortcuts = new Map();
	const commands = new Map();
	const sent = [];
	const pi = {
		on(name, handler) {
			const list = handlers.get(name) ?? [];
			list.push(handler);
			handlers.set(name, list);
		},
		registerShortcut(name, definition) {
			shortcuts.set(name, definition);
		},
		registerCommand(name, definition) {
			commands.set(name, definition);
		},
		sendMessage(message, options) {
			sent.push({ message, options });
		},
	};
	return { pi, handlers, shortcuts, commands, sent };
}

function createContext(sessionId) {
	const notifications = [];
	return {
		notifications,
		ctx: {
			sessionManager: { getSessionId: () => sessionId },
			ui: {
				notify: (message, level) => notifications.push({ message, level }),
				addAutocompleteProvider: () => {},
			},
		},
	};
}

async function importBg(root) {
	process.env.PI_BG_DIR = root;
	process.env.PI_BG_DEBOUNCE_MS = "0";
	const { default: registerBg, sweep } = await import(`../extensions/bg.ts?test=${Date.now()}-${Math.random()}`);
	return { registerBg, sweep };
}

/** tool_call 이벤트에 `# bg:run` 마커 명령을 통과시켜 job dir을 반환한다. */
async function runViaMarker(toolCall, ctx, command, root) {
	const event = {
		type: "tool_call",
		toolCallId: `bg-run-${Date.now()}`,
		toolName: "bash",
		input: { command },
	};
	await toolCall(event, ctx);
	const jobDir = await waitFor(async () => {
		const entries = await readdir(root);
		for (const e of entries) {
			const candidate = join(root, e);
			try {
				await stat(join(candidate, "jobpid"));
				return candidate;
			} catch {
				/* 아직 jobpid 없거나 다른 job */
			}
		}
		return undefined;
	}, "marker job dir");
	return { jobDir, rewritten: event.input.command };
}

async function waitExit(jobDir, expected) {
	return waitFor(async () => {
		try {
			return (await readFile(join(jobDir, "exit"), "utf8")).trim() === expected;
		} catch {
			return false;
		}
	}, `exit=${expected}`);
}

test("# bg:run marker: tool_call rewrites to echo, job dir created with metadata", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-bg-redesign-"));
	try {
		const { registerBg } = await importBg(root);
		const harness = createHarness();
		registerBg(harness.pi);
		const toolCall = harness.handlers.get("tool_call")[0];
		const owner = createContext("session-owner");

		const { jobDir, rewritten } = await runViaMarker(
			toolCall,
			owner.ctx,
			"sleep 0.2 && echo marker-ok # bg:run",
			root,
		);

		// 1) 툴 콜은 즉시 echo로 재작성 (v2.1-A: "started in")
		assert.match(rewritten, /^echo "\[bg\] started in background job=/);
		assert.match(rewritten, /완료 시 자동 통지됩니다/);

		// 2) 메타데이터 — cmd는 마커 제거된 평문, session, backgrounded
		assert.equal((await readFile(join(jobDir, "cmd"), "utf8")).trim(), "sleep 0.2 && echo marker-ok");
		assert.equal((await readFile(join(jobDir, "session"), "utf8")).trim(), "session-owner");
		assert.equal((await readFile(join(jobDir, "backgrounded"), "utf8")).trim(), "1");

		// 3) pid 파일 = job bash PID (신 형식, 하위 호환)
		const pid = (await readFile(join(jobDir, "pid"), "utf8")).trim();
		const jobpid = (await readFile(join(jobDir, "jobpid"), "utf8")).trim();
		assert.equal(pid, jobpid);
		assert.match(pid, /^\d+$/);

		// 4) 작업 실제 실행 → 로그 + exit 0
		await waitExit(jobDir, "0");
		const log = await readFile(join(jobDir, "log"), "utf8");
		assert.match(log, /marker-ok/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("spawned job runs in its own process group (PGID == PID)", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-bg-redesign-"));
	try {
		const { registerBg } = await importBg(root);
		const harness = createHarness();
		registerBg(harness.pi);
		const toolCall = harness.handlers.get("tool_call")[0];
		const owner = createContext("session-owner");

		const { jobDir } = await runViaMarker(toolCall, owner.ctx, "sleep 3 # bg:run", root);
		const pid = Number((await readFile(join(jobDir, "jobpid"), "utf8")).trim());

		// ps -o pgid: detached:true → 자식 bash가 새 PGID 리더
		const pgid = Number(
			execFileSync("ps", ["-o", "pgid=", "-p", String(pid)], { encoding: "utf8" }).trim(),
		);
		assert.equal(pgid, pid, "job bash must be its own process group leader");

		// 그룹 킬 검증: -PID로 signaled되면 job bash + 자식(sleep) 모두 종료.
		// (그룹 킬은 exit 파일 없이 "gone" — 구 래퍼와 동일)
		process.kill(-pid, "SIGTERM");
		await waitFor(async () => {
			try {
				execFileSync("ps", ["-p", String(pid)], { encoding: "utf8" });
				return false; // 아직 생존
			} catch {
				return true; // 종료됨
			}
		}, "group kill");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("completion writes exit code (non-zero preserved)", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-bg-redesign-"));
	try {
		const { registerBg } = await importBg(root);
		const harness = createHarness();
		registerBg(harness.pi);
		const toolCall = harness.handlers.get("tool_call")[0];
		const owner = createContext("session-owner");

		const { jobDir } = await runViaMarker(toolCall, owner.ctx, "exit 42 # bg:run", root);
		await waitExit(jobDir, "42");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("multi-line command survives (R-4: cmd file eval, not JSON.stringify embed)", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-bg-redesign-"));
	try {
		const { registerBg } = await importBg(root);
		const harness = createHarness();
		registerBg(harness.pi);
		const toolCall = harness.handlers.get("tool_call")[0];
		const owner = createContext("session-owner");

		const multiLine = "echo line-one\necho line-two";
		const { jobDir } = await runViaMarker(toolCall, owner.ctx, `${multiLine} # bg:run`, root);
		await waitExit(jobDir, "0");
		const log = await readFile(join(jobDir, "log"), "utf8");
		assert.match(log, /line-one/);
		assert.match(log, /line-two/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("marker job completion auto-injects via sweep (session-scoped, once)", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-bg-redesign-"));
	try {
		const { registerBg, sweep } = await importBg(root);
		const harness = createHarness();
		registerBg(harness.pi);
		const toolCall = harness.handlers.get("tool_call")[0];
		const owner = createContext("session-owner");
		const other = createContext("session-other");

		const { jobDir } = await runViaMarker(toolCall, owner.ctx, "sleep 0.2 && echo sweep-me # bg:run", root);
		await waitExit(jobDir, "0");

		// 다른 세션 sweep → 무시
		sweep(harness.pi, "session-other");
		assert.equal(harness.sent.length, 0);

		// 소유 세션 sweep → 주입 (customType bg-complete, followUp + triggerTurn)
		// (debounce 0ms라도 flush는 타이머 1틱 지연 — async 대기 필요)
		sweep(harness.pi, "session-owner");
		await new Promise((r) => setTimeout(r, 20));
		assert.equal(harness.sent.length, 1);
		assert.equal(harness.sent[0].message.customType, "bg-complete");
		assert.match(harness.sent[0].message.content, /sweep-me/);
		assert.deepEqual(harness.sent[0].options, { deliverAs: "followUp", triggerTurn: true });

		// 1회 보장 — 재 sweep 무주입
		sweep(harness.pi, "session-owner");
		assert.equal(harness.sent.length, 1);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("# bg:quiet marker job completes without notification", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-bg-redesign-"));
	try {
		const { registerBg, sweep } = await importBg(root);
		const harness = createHarness();
		registerBg(harness.pi);
		const toolCall = harness.handlers.get("tool_call")[0];
		const owner = createContext("session-owner");

		const { jobDir } = await runViaMarker(
			toolCall,
			owner.ctx,
			"sleep 0.2 && echo quiet-ok # bg:run # bg:quiet",
			root,
		);
		// quiet 마커는 cmd에서 제거되고 quiet 파일로 기록
		assert.equal((await readFile(join(jobDir, "cmd"), "utf8")).trim(), "sleep 0.2 && echo quiet-ok");
		assert.equal((await readFile(join(jobDir, "quiet"), "utf8")).trim(), "1");

		await waitExit(jobDir, "0");
		sweep(harness.pi, "session-owner");
		assert.equal(harness.sent.length, 0);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("/bgrun command: registered unconditionally, creates job, notifies with details", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-bg-redesign-"));
	try {
		const { registerBg } = await importBg(root);
		const harness = createHarness();
		registerBg(harness.pi);
		const owner = createContext("session-owner");

		// 무조건 등록 (job 없이도)
		assert.ok(harness.commands.has("bgrun"), "/bgrun must be registered at load");

		await harness.commands.get("bgrun").handler("sleep 0.2 && echo bgrun-ok", owner.ctx);
		const notice = owner.notifications.find((n) => n.message.includes("백그라운드 시작"));
		assert.ok(notice, "start notification");
		assert.match(notice.message, /job: \d+-\d+-\d+/);
		assert.match(notice.message, /log: /);

		// job dir 생성 + 실행 완료
		const jobDir = await waitFor(async () => {
			const entries = await readdir(root);
			for (const e of entries) {
				const candidate = join(root, e);
				try {
					await stat(join(candidate, "jobpid"));
					return candidate;
				} catch {
					/* skip */
				}
			}
			return undefined;
		}, "bgrun job dir");
		await waitExit(jobDir, "0");
		assert.match(await readFile(join(jobDir, "log"), "utf8"), /bgrun-ok/);

		// /bgrun 호출 후 /bglist·/bgkill 등록 (조건부 등록 트리거)
		assert.ok(harness.commands.has("bglist"));
		assert.ok(harness.commands.has("bgkill"));

		// 빈 인자 → 사용법 안내
		await harness.commands.get("bgrun").handler("", owner.ctx);
		assert.ok(owner.notifications.some((n) => n.message.includes("사용법")));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("Phase 1 parallel: command WITHOUT marker is still wrapped (legacy path intact)", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-bg-redesign-"));
	try {
		const { registerBg } = await importBg(root);
		const harness = createHarness();
		registerBg(harness.pi);
		const toolCall = harness.handlers.get("tool_call")[0];
		const owner = createContext("session-owner");

		const event = {
			type: "tool_call",
			toolCallId: "legacy-wrap",
			toolName: "bash",
			input: { command: "echo legacy-still-wrapped" },
		};
		await toolCall(event, owner.ctx);

		// 기존 래퍼 그대로 (tail -f + jobpid 폴링) — Phase 2에서 제거 예정
		assert.match(event.input.command, /tail -n \+1 -f/);
		assert.match(event.input.command, /JOBPID/);
		assert.doesNotMatch(event.input.command, /started in background/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("no orphan tail processes from marker path", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-bg-redesign-"));
	try {
		const { registerBg } = await importBg(root);
		const harness = createHarness();
		registerBg(harness.pi);
		const toolCall = harness.handlers.get("tool_call")[0];
		const owner = createContext("session-owner");

		const { jobDir } = await runViaMarker(toolCall, owner.ctx, "sleep 2 # bg:run", root);
		const pid = (await readFile(join(jobDir, "pid"), "utf8")).trim();

		// 실행 중 확인: 마커 경로는 tail 프로세스를 spawn하지 않는다 — job pid가 bash임
		const cmd = execFileSync("ps", ["-o", "command=", "-p", pid], { encoding: "utf8" }).trim();
		assert.match(cmd, /bash/);
		assert.doesNotMatch(cmd, /tail/);

		process.kill(-Number(pid), "SIGTERM");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

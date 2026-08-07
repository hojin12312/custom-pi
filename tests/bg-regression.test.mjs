import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, stat, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import test from "node:test";

async function waitFor(check, message, timeoutMs = 6000) {
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
	};
	return { pi, handlers, shortcuts, commands };
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

function runWrapped(command) {
	const child = spawn("/bin/bash", ["-c", command], {
		detached: true,
		stdio: ["ignore", "pipe", "pipe"],
	});
	let output = "";
	child.stdout.on("data", (chunk) => (output += chunk));
	child.stderr.on("data", (chunk) => (output += chunk));
	return { child, output: () => output, done: once(child, "exit") };
}

test("only explicitly backgrounded jobs notify their owning Pi session", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-bg-regression-"));
	process.env.PI_BG_DIR = root;
	let activeChild;

	try {
		const { default: registerBg } = await import(`../extensions/bg.ts?test=${Date.now()}`);
		const harness = createHarness();
		registerBg(harness.pi);
		const toolCall = harness.handlers.get("tool_call")[0];
		const input = harness.handlers.get("input")[0];
		const shortcut = harness.shortcuts.get("ctrl+q");
		const owner = createContext("session-owner");
		const other = createContext("session-other");

		const foregroundEvent = {
			type: "tool_call",
			toolCallId: "foreground",
			toolName: "bash",
			input: { command: "printf 'foreground-ok\\n'" },
		};
		await toolCall(foregroundEvent, owner.ctx);
		const foreground = runWrapped(foregroundEvent.input.command);
		const [foregroundCode] = await foreground.done;
		assert.equal(foregroundCode, 0);
		assert.match(foreground.output(), /foreground-ok/);
		assert.deepEqual(await readdir(root), [], "foreground metadata must be removed");
		assert.deepEqual(
			await input({ type: "input", source: "interactive", text: "next prompt" }, owner.ctx),
			{ action: "continue" },
			"ordinary foreground completion must not create a bg notice",
		);

		const legacyDir = join(root, "legacy-job");
		await mkdir(legacyDir);
		await writeFile(join(legacyDir, "exit"), "0");
		await writeFile(join(legacyDir, "cmd"), "old foreground command");
		await writeFile(join(legacyDir, "log"), "old output");
		assert.deepEqual(
			await input({ type: "input", source: "interactive", text: "new session prompt" }, other.ctx),
			{ action: "continue" },
			"legacy global records without ownership/background marker must be ignored",
		);

		const backgroundEvent = {
			type: "tool_call",
			toolCallId: "background",
			toolName: "bash",
			input: { command: "printf 'background-started\\n'; sleep 3; printf 'background-finished\\n'" },
		};
		await toolCall(backgroundEvent, owner.ctx);
		const background = runWrapped(backgroundEvent.input.command);
		activeChild = background.child;
		const jobDir = await waitFor(async () => {
			const entries = (await readdir(root)).filter((entry) => entry !== "legacy-job");
			if (entries.length !== 1) return undefined;
			const candidate = join(root, entries[0]);
			try {
				await stat(join(candidate, "jobpid"));
				return candidate;
			} catch {
				return undefined;
			}
		}, "wrapped background candidate");

		await shortcut.handler(other.ctx);
		assert.match(other.notifications.at(-1).message, /실행 중인 작업이 없습니다/);
		await assert.rejects(stat(join(jobDir, "backgrounded")));

		await shortcut.handler(owner.ctx);
		assert.match(owner.notifications.at(-1).message, /백그라운드로 전환했습니다/);
		await background.done;
		activeChild = undefined;
		assert.equal(await readFile(join(jobDir, "session"), "utf8"), "session-owner");
		await stat(join(jobDir, "backgrounded"));

		assert.deepEqual(
			await input({ type: "input", source: "interactive", text: "unrelated session" }, other.ctx),
			{ action: "continue" },
			"another session must not see the owner's running job",
		);
		const runningNotice = await input(
			{ type: "input", source: "interactive", text: "owner follow-up" },
			owner.ctx,
		);
		assert.equal(runningNotice.action, "transform");
		assert.match(runningNotice.text, /백그라운드 작업 .* 실행 중/);

		await waitFor(async () => {
			try {
				return (await readFile(join(jobDir, "exit"), "utf8")).trim() === "0";
			} catch {
				return false;
			}
		}, "background completion");
		const completedNotice = await input(
			{ type: "input", source: "interactive", text: "owner completion check" },
			owner.ctx,
		);
		assert.equal(completedNotice.action, "transform");
		assert.match(completedNotice.text, /완료 \(exit 0\)/);
		assert.match(completedNotice.text, /background-finished/);
		assert.deepEqual(
			await input({ type: "input", source: "interactive", text: "already notified" }, owner.ctx),
			{ action: "continue" },
			"completion notice must be emitted only once",
		);
	} finally {
		if (activeChild?.pid) {
			try {
				process.kill(-activeChild.pid, "SIGKILL");
			} catch {}
		}
		delete process.env.PI_BG_DIR;
		await rm(root, { recursive: true, force: true });
	}
});

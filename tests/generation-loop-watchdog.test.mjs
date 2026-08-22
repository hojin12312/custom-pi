import assert from "node:assert/strict";
import test from "node:test";


async function loadModule(tag = "unit") {
	return import(`../extensions/generation-loop-watchdog.ts?${tag}=${Date.now()}-${Math.random()}`);
}

const repeated = "Let me look at the web patch logs, the web patch process, and the configuration. ";
const lowDiversityRepeated = "`content` — ";

test("detects the observed repeated sentence while it is streaming", async () => {
	const { GenerationLoopTracker } = await loadModule();
	const tracker = new GenerationLoopTracker();
	tracker.startMessage();
	let detection;
	for (let i = 0; i < 10 && !detection; i++) detection = tracker.push("thinking_delta:0", repeated);
	assert.ok(detection);
	assert.equal(detection.mode, "substantial");
	assert.equal(detection.repeats, 6);
	assert.ok(detection.blockTokens >= 8);
});

test("detects repetition when provider deltas split words", async () => {
	const { GenerationLoopTracker } = await loadModule("split-deltas");
	const tracker = new GenerationLoopTracker();
	tracker.startMessage();
	const chunks = ["LOOP", " WATCH", "DOG", " VALID", "ATION", " PH", "R", "ASE", ".", "\n"];
	let detection;
	for (let repetition = 0; repetition < 40 && !detection; repetition++) {
		for (const chunk of chunks) {
			detection = tracker.push("text_delta:0", chunk);
			if (detection) break;
		}
	}
	assert.ok(detection);
	assert.equal(detection.mode, "substantial");
	assert.equal(detection.repeats, 6);
});

for (const channel of ["thinking_delta:0", "text_delta:0"]) {
	test(`detects the observed low-diversity loop in ${channel}`, async () => {
		const { GenerationLoopTracker } = await loadModule(`low-diversity-${channel}`);
		const tracker = new GenerationLoopTracker();
		tracker.startMessage();
		const chunks = ["`con", "tent", "` — "];
		let detection;
		let streamedChars = 0;
		for (let repetition = 0; repetition < 100 && !detection; repetition++) {
			for (const chunk of chunks) {
				streamedChars += chunk.length;
				detection = tracker.push(channel, chunk);
				if (detection) break;
			}
		}
		assert.ok(detection);
		assert.equal(detection.mode, "low-diversity");
		assert.equal(detection.repeats, 12);
		assert.ok(streamedChars >= 256);
		assert.ok(streamedChars < 512);
	});
}

test("does not flag low-diversity text before the 256-character floor", async () => {
	const { GenerationLoopTracker } = await loadModule("low-diversity-floor");
	const tracker = new GenerationLoopTracker();
	tracker.startMessage();
	assert.equal(tracker.push("thinking_delta:0", lowDiversityRepeated.repeat(20)), undefined);
});

test("does not flag varied long-form prose", async () => {
	const { GenerationLoopTracker } = await loadModule();
	const tracker = new GenerationLoopTracker();
	tracker.startMessage();
	let detection;
	for (let i = 0; i < 40; i++) {
		detection = tracker.push("text_delta:0", `Step ${i} examines a different subsystem and records result ${i * 17}. `);
		assert.equal(detection, undefined);
	}
});

test("ignores short separators and keeps channels independent", async () => {
	const { GenerationLoopTracker } = await loadModule();
	const tracker = new GenerationLoopTracker();
	tracker.startMessage();
	for (let i = 0; i < 100; i++) {
		assert.equal(tracker.push("text_delta:0", "---\n"), undefined);
		assert.equal(
			tracker.push("thinking_delta:0", i % 2 ? repeated : `A different analysis path ${i} is considered here. `),
			undefined,
		);
	}
});

test("does not flag varied tables and lists", async () => {
	const { GenerationLoopTracker } = await loadModule("varied-structured-output");
	const tracker = new GenerationLoopTracker();
	tracker.startMessage();
	for (let i = 0; i < 80; i++) {
		assert.equal(
			tracker.push("text_delta:0", `| row-${i} | value-${i * 13} |\n- item-${i}: result-${i * 17}\n`),
			undefined,
		);
	}
});

test("low-diversity integration aborts and uses the existing single recovery cap", async () => {
	const { default: register } = await loadModule("low-diversity-integration");
	const handlers = new Map();
	const sent = [];
	const pi = {
		on(name, handler) { handlers.set(name, handler); },
		registerCommand() {},
		sendUserMessage(message) { sent.push(message); },
	};
	register(pi);
	let aborts = 0;
	const ctx = { hasUI: false, ui: { notify() {} }, abort() { aborts++; } };
	const start = { message: { role: "assistant", content: [] } };

	await handlers.get("input")({ source: "interactive" }, ctx);
	for (const type of ["thinking_delta", "text_delta"]) {
		await handlers.get("message_start")(start, ctx);
		for (let i = 0; i < 50 && aborts < (type === "thinking_delta" ? 1 : 2); i++) {
			await handlers.get("message_update")({
				assistantMessageEvent: { type, contentIndex: 0, delta: lowDiversityRepeated },
			}, ctx);
		}
		await handlers.get("agent_settled")({}, ctx);
	}

	assert.equal(aborts, 2);
	assert.equal(sent.length, 1);
});

test("integration aborts promptly and auto-recovers only once", async () => {
	const { default: register } = await loadModule("integration");
	const handlers = new Map();
	const commands = new Map();
	const sent = [];
	const pi = {
		on(name, handler) { handlers.set(name, handler); },
		registerCommand(name, command) { commands.set(name, command); },
		sendUserMessage(message) { sent.push(message); },
	};
	register(pi);
	let aborts = 0;
	const ctx = { hasUI: false, ui: { notify() {} }, abort() { aborts++; } };
	const start = { message: { role: "assistant", content: [] } };

	await handlers.get("input")({ source: "interactive" }, ctx);
	await handlers.get("message_start")(start, ctx);
	for (let i = 0; i < 10 && aborts === 0; i++) {
		await handlers.get("message_update")({
			assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: repeated },
		}, ctx);
	}
	assert.equal(aborts, 1);
	await handlers.get("agent_settled")({}, ctx);
	assert.equal(sent.length, 1);
	assert.match(sent[0], /다른 전략/);

	await handlers.get("message_start")(start, ctx);
	for (let i = 0; i < 10 && aborts === 1; i++) {
		await handlers.get("message_update")({
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: repeated },
		}, ctx);
	}
	assert.equal(aborts, 2);
	await handlers.get("agent_settled")({}, ctx);
	assert.equal(sent.length, 1);
	assert.equal(commands.has("generation-loop-status"), true);
});

test("a new external user prompt resets the recovery allowance", async () => {
	const { default: register } = await loadModule("reset");
	const handlers = new Map();
	const sent = [];
	const pi = {
		on(name, handler) { handlers.set(name, handler); },
		registerCommand() {},
		sendUserMessage(message) { sent.push(message); },
	};
	register(pi);
	const ctx = { hasUI: false, ui: { notify() {} }, abort() {} };
	for (let prompt = 0; prompt < 2; prompt++) {
		await handlers.get("input")({ source: "interactive" }, ctx);
		await handlers.get("message_start")({ message: { role: "assistant" } }, ctx);
		for (let i = 0; i < 10; i++) {
			await handlers.get("message_update")({
				assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: repeated },
			}, ctx);
		}
		await handlers.get("agent_settled")({}, ctx);
	}
	assert.equal(sent.length, 2);
});

test("turn fingerprints match only for the same assistant and tool batch", async () => {
	const { turnFingerprint } = await loadModule("turns");
	const turn = {
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "I will inspect the logs." },
			{ type: "toolCall", name: "bash", arguments: { command: "tail -20 app.log" } },
		],
	};
	assert.equal(turnFingerprint(turn), turnFingerprint(structuredClone(turn)));
	const changed = structuredClone(turn);
	changed.content[1].arguments.command = "tail -40 app.log";
	assert.notEqual(turnFingerprint(turn), turnFingerprint(changed));
	assert.equal(turnFingerprint({ role: "assistant", content: [{ type: "text", text: "Done" }] }), undefined);
});

import assert from "node:assert/strict";
import test from "node:test";

async function loadTracker() {
	const mod = await import(`../extensions/loop-guard.ts?test=${Date.now()}-${Math.random()}`);
	return mod.ExactLoopTracker;
}

const assistant = (text) => ({ role: "assistant", content: [{ type: "thinking", thinking: text }] });
const edit = (id = "edit-1") => ({
	type: "tool_call",
	toolCallId: id,
	toolName: "edit",
	input: { path: "/tmp/example.py", oldText: "old", newText: "new" },
});
const failedEdit = () => ({
	...edit(),
	type: "tool_result",
	isError: true,
	content: [{ type: "text", text: "Could not find oldText in /tmp/example.py" }],
	details: undefined,
});

test("identical assistant + edit input + error blocks the next call, then terminates", async () => {
	const Tracker = await loadTracker();
	const tracker = new Tracker();
	tracker.noteAssistant(assistant("I will update the test script."));
	tracker.noteFailure(failedEdit());

	assert.equal(tracker.inspectCall(edit("edit-2")).decision, "block");
	assert.equal(tracker.inspectCall(edit("edit-3")).decision, "terminate");
});

test("a changed assistant response is not an exact loop", async () => {
	const Tracker = await loadTracker();
	const tracker = new Tracker();
	tracker.noteAssistant(assistant("I will apply the edit."));
	tracker.noteFailure(failedEdit());
	tracker.noteAssistant(assistant("The edit failed; I will read the current file first."));

	assert.equal(tracker.inspectCall(edit("edit-2")).decision, "allow");
});

test("a changed tool input is not an exact loop", async () => {
	const Tracker = await loadTracker();
	const tracker = new Tracker();
	tracker.noteAssistant(assistant("I will apply the edit."));
	tracker.noteFailure(failedEdit());
	const different = edit("edit-2");
	different.input.oldText = "fresh old text";

	assert.equal(tracker.inspectCall(different).decision, "allow");
});

test("success and a new user prompt clear the prior failure record", async () => {
	const Tracker = await loadTracker();
	const tracker = new Tracker();
	tracker.noteAssistant(assistant("I will apply the edit."));
	tracker.noteFailure(failedEdit());
	tracker.noteSuccess({ ...failedEdit(), isError: false, content: [{ type: "text", text: "Done" }] });
	assert.equal(tracker.inspectCall(edit("edit-2")).decision, "allow");

	tracker.noteFailure(failedEdit());
	tracker.reset();
	assert.equal(tracker.inspectCall(edit("edit-3")).decision, "allow");
});

test("default policy does not guard bash failures", async () => {
	const Tracker = await loadTracker();
	const tracker = new Tracker();
	const bash = { type: "tool_call", toolCallId: "bash-1", toolName: "bash", input: { command: "false" } };
	tracker.noteAssistant(assistant("I will retry the command."));
	tracker.noteFailure({ ...bash, type: "tool_result", isError: true, content: [{ type: "text", text: "exit 1" }], details: undefined });
	assert.equal(tracker.inspectCall({ ...bash, toolCallId: "bash-2" }).decision, "allow");
});

test("registered handlers block an exact duplicate before it executes", async () => {
	const { default: register } = await import(`../extensions/loop-guard.ts?integration=${Date.now()}`);
	const handlers = new Map();
	const commands = new Map();
	const pi = {
		on(name, handler) { handlers.set(name, handler); },
		registerCommand(name, handler) { commands.set(name, handler); },
	};
	register(pi);
	const ctx = { hasUI: false, ui: { notify() {} } };
	await handlers.get("message_end")({ message: assistant("I will apply the edit.") }, ctx);
	await handlers.get("tool_result")(failedEdit(), ctx);

	const result = await handlers.get("tool_call")(edit("edit-2"), ctx);
	assert.deepEqual(result, {
		block: true,
		reason: result.reason,
		terminate: false,
	});
	assert.match(result.reason, /^\[loop-guard\]/);
	assert.equal(commands.has("loop-status"), true);
});

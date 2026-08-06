/**
 * Todo Extension - 3-state todo list (pending/in_progress/completed), matching
 * OpenCode's todo.ts data model. Adapted from Pi's official example
 * (examples/extensions/todo.ts), which uses a boolean `done` flag — this
 * version swaps that for a `status` enum so the agent can mark work
 * in_progress before completing it.
 *
 * State is stored in tool result details (not external files), which allows
 * proper branching - when you branch, the todo state is automatically
 * correct for that point in history.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";

type TodoStatus = "pending" | "in_progress" | "completed";

interface Todo {
	id: number;
	text: string;
	status: TodoStatus;
}

interface TodoDetails {
	action: "list" | "add" | "update" | "clear";
	todos: Todo[];
	nextId: number;
	error?: string;
}

const STATUS_ORDER: TodoStatus[] = ["pending", "in_progress", "completed"];

const TodoParams = Type.Object({
	action: StringEnum(["list", "add", "update", "clear"] as const),
	text: Type.Optional(Type.String({ description: "Todo text (for add)" })),
	id: Type.Optional(Type.Number({ description: "Todo ID (for update)" })),
	status: Type.Optional(StringEnum(STATUS_ORDER, { description: "New status (for update)" })),
});

function statusIcon(theme: Theme, status: TodoStatus): string {
	switch (status) {
		case "completed":
			return theme.fg("success", "✓");
		case "in_progress":
			return theme.fg("accent", "◐");
		default:
			return theme.fg("dim", "○");
	}
}

/**
 * UI component for the /todos command
 */
class TodoListComponent {
	private todos: Todo[];
	private theme: Theme;
	private onClose: () => void;
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(todos: Todo[], theme: Theme, onClose: () => void) {
		this.todos = todos;
		this.theme = theme;
		this.onClose = onClose;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.onClose();
		}
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) {
			return this.cachedLines;
		}

		const lines: string[] = [];
		const th = this.theme;

		lines.push("");
		const title = th.fg("accent", " Todos ");
		const headerLine =
			th.fg("borderMuted", "─".repeat(3)) + title + th.fg("borderMuted", "─".repeat(Math.max(0, width - 10)));
		lines.push(truncateToWidth(headerLine, width));
		lines.push("");

		if (this.todos.length === 0) {
			lines.push(truncateToWidth(`  ${th.fg("dim", "No todos yet. Ask the agent to add some!")}`, width));
		} else {
			const completed = this.todos.filter((t) => t.status === "completed").length;
			const total = this.todos.length;
			lines.push(truncateToWidth(`  ${th.fg("muted", `${completed}/${total} completed`)}`, width));
			lines.push("");

			for (const todo of this.todos) {
				const check = statusIcon(th, todo.status);
				const id = th.fg("accent", `#${todo.id}`);
				const text = todo.status === "completed" ? th.fg("dim", todo.text) : th.fg("text", todo.text);
				lines.push(truncateToWidth(`  ${check} ${id} ${text}`, width));
			}
		}

		lines.push("");
		lines.push(truncateToWidth(`  ${th.fg("dim", "Press Escape to close")}`, width));
		lines.push("");

		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}

function renderTodoList(todos: Todo[], theme: Theme, expanded?: boolean): string {
	if (todos.length === 0) {
		return theme.fg("dim", "  No todos");
	}
	const completed = todos.filter((t) => t.status === "completed").length;
	const total = todos.length;
	const lines: string[] = [];
	lines.push(theme.fg("muted", `  ${completed}/${total} completed`));
	lines.push("");

	const display = expanded ? todos : todos.slice(0, 10);
	for (const t of display) {
		const check = statusIcon(theme, t.status);
		const id = theme.fg("accent", `#${t.id}`);
		const text = t.status === "completed" ? theme.fg("dim", t.text) : theme.fg("text", t.text);
		lines.push(`  ${check} ${id} ${text}`);
	}
	if (!expanded && todos.length > 10) {
		lines.push(theme.fg("dim", `  ... ${todos.length - 10} more`));
	}
	return lines.join("\n");
}

export default function (pi: ExtensionAPI) {
	// In-memory state (reconstructed from session on load)
	let todos: Todo[] = [];
	let nextId = 1;

	/**
	 * Reconstruct state from session entries.
	 * Scans tool results for this tool and applies them in order.
	 */
	const reconstructState = (ctx: ExtensionContext) => {
		todos = [];
		nextId = 1;

		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "message") continue;
			const msg = entry.message;
			if (msg.role !== "toolResult" || msg.toolName !== "todo") continue;

			const details = msg.details as TodoDetails | undefined;
			if (details) {
				todos = details.todos;
				nextId = details.nextId;
			}
		}
	};

	pi.on("session_start", async (_event, ctx) => reconstructState(ctx));
	pi.on("session_tree", async (_event, ctx) => reconstructState(ctx));

	pi.registerTool({
		name: "todo",
		label: "Todo",
		description:
			"Manage a todo list with pending/in_progress/completed status. Actions: list, add (text), update (id, status), clear",
		promptSnippet: "Track multi-step work as a todo list with pending/in_progress/completed status",
		promptGuidelines: [
			"Use todo to break multi-step tasks into tracked items, mark one in_progress before starting it, and mark it completed as soon as it is done.",
		],
		parameters: TodoParams,

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			switch (params.action) {
				case "list":
					return {
						content: [
							{
								type: "text",
								text: todos.length
									? todos
											.map((t) => `[${t.status === "completed" ? "x" : t.status === "in_progress" ? "~" : " "}] #${t.id}: ${t.text}`)
											.join("\n")
									: "No todos",
							},
						],
						details: { action: "list", todos: [...todos], nextId } as TodoDetails,
					};

				case "add": {
					if (!params.text) {
						return {
							content: [{ type: "text", text: "Error: text required for add" }],
							details: { action: "add", todos: [...todos], nextId, error: "text required" } as TodoDetails,
						};
					}
					const newTodo: Todo = { id: nextId++, text: params.text, status: "pending" };
					todos.push(newTodo);
					return {
						content: [{ type: "text", text: `Added todo #${newTodo.id}: ${newTodo.text}` }],
						details: { action: "add", todos: [...todos], nextId } as TodoDetails,
					};
				}

				case "update": {
					if (params.id === undefined) {
						return {
							content: [{ type: "text", text: "Error: id required for update" }],
							details: { action: "update", todos: [...todos], nextId, error: "id required" } as TodoDetails,
						};
					}
					if (!params.status) {
						return {
							content: [{ type: "text", text: "Error: status required for update" }],
							details: { action: "update", todos: [...todos], nextId, error: "status required" } as TodoDetails,
						};
					}
					const todo = todos.find((t) => t.id === params.id);
					if (!todo) {
						return {
							content: [{ type: "text", text: `Todo #${params.id} not found` }],
							details: {
								action: "update",
								todos: [...todos],
								nextId,
								error: `#${params.id} not found`,
							} as TodoDetails,
						};
					}
					todo.status = params.status as TodoStatus;
					return {
						content: [{ type: "text", text: `Todo #${todo.id} -> ${todo.status}` }],
						details: { action: "update", todos: [...todos], nextId } as TodoDetails,
					};
				}

				case "clear": {
					const count = todos.length;
					todos = [];
					nextId = 1;
					return {
						content: [{ type: "text", text: `Cleared ${count} todos` }],
						details: { action: "clear", todos: [], nextId: 1 } as TodoDetails,
					};
				}

				default:
					return {
						content: [{ type: "text", text: `Unknown action: ${params.action}` }],
						details: {
							action: "list",
							todos: [...todos],
							nextId,
							error: `unknown action: ${params.action}`,
						} as TodoDetails,
					};
			}
		},

		renderCall(args, theme, _context) {
			let text = theme.fg("toolTitle", theme.bold("todo ")) + theme.fg("muted", args.action);
			if (args.text) text += ` ${theme.fg("dim", `"${args.text}"`)}`;
			if (args.id !== undefined) text += ` ${theme.fg("accent", `#${args.id}`)}`;
			if (args.status) text += ` ${theme.fg("accent", `-> ${args.status}`)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme, _context) {
			const details = result.details as TodoDetails | undefined;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}

			if (details.error) {
				return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);
			}

			const todoList = details.todos;

			switch (details.action) {
				case "list": {
					if (todoList.length === 0) {
						return new Text(theme.fg("dim", "No todos"), 0, 0);
					}
					return new Text(renderTodoList(todoList, theme, expanded), 0, 0);
				}

				case "add": {
					const added = todoList[todoList.length - 1];
					const header =
						theme.fg("success", "✓ Added ") +
						theme.fg("accent", `#${added.id}`) +
						" " +
						theme.fg("muted", added.text);
					const listBody = renderTodoList(todoList, theme, expanded);
					return new Text(`${header}\n\n${listBody}`, 0, 0);
				}

				case "update": {
					const text = result.content[0];
					const msg = text?.type === "text" ? text.text : "";
					const header = theme.fg("success", "✓ ") + theme.fg("muted", msg);
					const listBody = renderTodoList(todoList, theme, expanded);
					return new Text(`${header}\n\n${listBody}`, 0, 0);
				}

				case "clear":
					return new Text(theme.fg("success", "✓ ") + theme.fg("muted", "Cleared all todos"), 0, 0);
			}
		},
	});

	pi.registerCommand("todos", {
		description: "Show all todos on the current branch",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/todos requires interactive mode", "error");
				return;
			}

			await ctx.ui.custom<void>((_tui, theme, _kb, done) => {
				return new TodoListComponent(todos, theme, () => done());
			});
		},
	});
}

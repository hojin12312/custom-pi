/**
 * Core Commands Extension — adds `/exit` and `/clear` slash commands.
 *
 * - `/exit`  : Gracefully shutdown Pi and exit (same as `/quit`). Uses the
 *   extension context `ctx.shutdown()`, which defers until the agent is idle
 *   in interactive/RPC mode and emits `session_shutdown` to all extensions.
 * - `/clear` : Start a new session (same as `/new`). Uses `ctx.newSession()`,
 *   which routes to the exact same `runtimeHost.newSession()` path as the
 *   builtin `/new` command handler.
 *
 * Implemented as an extension (not a core patch) so it survives Pi updates.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.registerCommand("exit", {
		description: "Quit Pi (same as /quit)",
		handler: async (_args, ctx) => {
			ctx.shutdown();
		},
	});

	pi.registerCommand("clear", {
		description: "Start a new session (same as /new)",
		handler: async (_args, ctx) => {
			const result = await ctx.newSession();
			if (result.cancelled) {
				return;
			}
		},
	});
}

/**
 * web_search_content — OpenCode-style raw-content web search (Exa MCP)
 *
 * Port of OpenCode's built-in `websearch` tool for Pi.
 * Difference vs pi-web-access `web_search`:
 *   - Returns RAW page content (up to contextMaxCharacters per result,
 *     live-crawled when cached content is unavailable) instead of an
 *     AI-synthesized answer — the model reads the sources and answers
 *     directly, so exact params/versions/error text stay grounded.
 *   - Single query, single provider (Exa), fast, compact one-line TUI.
 *
 * Usage split (see promptSnippet):
 *   - web_search_content : quick factual lookups needing ground truth
 *   - web_search         : broad multi-query research / synthesized overviews
 *   - fetch_content      : fetching a URL you already know
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

const MCP_URL = () =>
	process.env.EXA_API_KEY
		? `https://mcp.exa.ai/mcp?exaApiKey=${encodeURIComponent(process.env.EXA_API_KEY)}`
		: "https://mcp.exa.ai/mcp";

const DEFAULT_NUM_RESULTS = 8;
const DEFAULT_CONTEXT_CHARS = 10000;
const TIMEOUT_MS = 25_000;

const Params = Type.Object({
	query: Type.String({ description: "Web search query" }),
	numResults: Type.Optional(
		Type.Number({ description: "Number of search results to return (default: 8, max: 20)" }),
	),
	type: Type.Optional(
		StringEnum(["auto", "fast", "deep"], {
			description: "Search type - 'auto': balanced search (default), 'fast': quick results, 'deep': comprehensive search",
		}),
	),
	livecrawl: Type.Optional(
		StringEnum(["fallback", "preferred"], {
			description:
				"Live crawl mode - 'fallback': use live crawling as backup if cached content unavailable (default), 'preferred': prioritize live crawling",
		}),
	),
	contextMaxCharacters: Type.Optional(
		Type.Number({
			description: "Maximum characters for context string optimized for LLMs (default: 10000)",
		}),
	),
});

interface McpContentPart {
	type?: string;
	text?: string;
}

interface McpPayload {
	result?: {
		content?: McpContentPart[];
		isError?: boolean;
	};
}

/** Extract the text content from an MCP tools/call response (direct JSON or SSE lines). */
function parseMcpOutput(body: string): { text: string; isError: boolean } {
	const parsePayload = (payload: string): McpPayload | undefined => {
		const trimmed = payload.trim();
		if (!trimmed.startsWith("{")) return undefined;
		try {
			return JSON.parse(trimmed) as McpPayload;
		} catch {
			return undefined;
		}
	};

	const findText = (data: McpPayload | undefined): string | undefined => {
		const content = data?.result?.content;
		if (!Array.isArray(content)) return undefined;
		return content.find((part) => part.type === "text")?.text;
	};

	const direct = parsePayload(body);
	const directText = findText(direct);
	if (directText !== undefined) return { text: directText, isError: direct?.result?.isError === true };

	for (const line of body.split("\n")) {
		if (!line.startsWith("data: ")) continue;
		const payload = parsePayload(line.substring(6));
		const text = findText(payload);
		if (text !== undefined) return { text, isError: payload?.result?.isError === true };
	}

	const trimmed = body.trim();
	if (trimmed.length > 0) return { text: trimmed, isError: false };
	return { text: "No search results found. Please try a different query.", isError: false };
}

function extractUrls(text: string): string[] {
	const seen = new Set<string>();
	const urls: string[] = [];
	const re = /https?:\/\/[^\s<>"'\\)\]]+/g;
	for (const match of text.matchAll(re)) {
		const url = match[0].replace(/[.,;:!?]+$/, "");
		if (seen.has(url)) continue;
		seen.add(url);
		urls.push(url);
		if (urls.length >= 20) break;
	}
	return urls;
}

async function callExaMcp(args: Record<string, unknown>, signal: AbortSignal): Promise<string> {
	const response = await fetch(MCP_URL(), {
		method: "POST",
		headers: {
			accept: "application/json, text/event-stream",
			"content-type": "application/json",
		},
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: { name: "web_search_exa", arguments: args },
		}),
		signal,
	});

	if (!response.ok) {
		const detail = (await response.text()).slice(0, 200);
		if (response.status === 429) {
			throw new Error(
				`Exa rate limit reached (429). Add "exaApiKey" to ~/.pi/web-search.json or set EXA_API_KEY for unthrottled search. ${detail}`,
			);
		}
		throw new Error(`Exa MCP error ${response.status}: ${detail}`);
	}

	const body = await response.text();
	const { text, isError } = parseMcpOutput(body);
	if (isError) throw new Error(`Exa search failed: ${text.slice(0, 300)}`);
	return text;
}

export default function webSearchContent(pi: ExtensionAPI) {
	pi.registerTool({
		name: "web_search_content",
		label: "Web Search (Content)",
		description:
			"Fast web search returning RAW page content (up to 10,000 characters per result, live-crawled when cached content is unavailable) instead of an AI-synthesized answer. Ported from OpenCode's websearch tool (Exa). Use for factual lookups where exact details from the source pages matter: current versions, API parameters, error messages, code snippets, prices. Read the returned content and answer directly with precise details. For broad multi-query research or synthesized overviews with citations, prefer web_search. For a URL you already know, prefer fetch_content.",
		promptSnippet:
			"Quick factual lookup returning RAW page content (up to 10k chars/result). Use for ground-truth details (versions, params, errors, code). Single query only; for broad research use web_search; for known URLs use fetch_content.",
		parameters: Params,

		async execute(_toolCallId, params, signal, onUpdate) {
			const query = params.query;
			const args = {
				query,
				type: params.type ?? "auto",
				numResults: params.numResults ?? DEFAULT_NUM_RESULTS,
				livecrawl: params.livecrawl ?? "fallback",
				contextMaxCharacters: params.contextMaxCharacters ?? DEFAULT_CONTEXT_CHARS,
			};

			onUpdate?.({
				content: [{ type: "text", text: `Searching: "${query}"...` }],
				details: { phase: "searching", query },
			});

			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
			const merged = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
			try {
				const text = await callExaMcp(args, merged);
				const sources = extractUrls(text);
				return {
					content: [{ type: "text", text }],
					details: { query, provider: "exa", numResults: args.numResults, sources },
				};
			} finally {
				clearTimeout(timer);
			}
		},

		renderCall(args, theme) {
			const query = (args as { query?: string }).query ?? "";
			const display = query.length > 60 ? query.slice(0, 57) + "..." : query;
			return new Text(theme.fg("toolTitle", theme.bold("search ")) + theme.fg("accent", `"${display}"`), 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			const details = (result.details ?? {}) as { sources?: string[]; query?: string };
			const sources = Array.isArray(details.sources) ? details.sources : [];
			const status = `${sources.length} sources`;
			if (!expanded) {
				return new Text(theme.fg("success", status), 0, 0);
			}
			const lines = [theme.fg("success", status)];
			for (const url of sources.slice(0, 12)) {
				lines.push(theme.fg("muted", `  ${url}`));
			}
			if (sources.length > 12) {
				lines.push(theme.fg("dim", `  ... and ${sources.length - 12} more`));
			}
			return new Text(lines.join("\n"), 0, 0);
		},
	});
}

/**
 * apply_patch tool - ports OpenCode's self-contained unified-patch algorithm
 * (packages/opencode/src/patch/index.ts, packages/opencode/src/tool/apply_patch.ts)
 * to a plain Pi custom tool. The parsing/matching functions below (parsePatch,
 * deriveNewContentsFromChunks, computeReplacements, seekSequence, ...) are a
 * verbatim port of OpenCode's pure logic with the Effect/Schema/service
 * plumbing stripped out and replaced with node:fs + ctx.ui.confirm.
 *
 * Patch format (OpenAI's "*** Begin Patch" dialect, not standard unified diff):
 *   *** Begin Patch
 *   *** Add File: path/to/new.txt
 *   +line one
 *   +line two
 *   *** Update File: path/to/existing.txt
 *   @@ optional context line
 *    unchanged line
 *   -removed line
 *   +added line
 *   *** Delete File: path/to/old.txt
 *   *** End Patch
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { Type } from "typebox";

// ── Types (ported from patch/index.ts) ──────────────────────────────────────

type Hunk =
	| { type: "add"; path: string; contents: string }
	| { type: "delete"; path: string }
	| { type: "update"; path: string; move_path?: string; chunks: UpdateFileChunk[] };

interface UpdateFileChunk {
	old_lines: string[];
	new_lines: string[];
	change_context?: string;
	is_end_of_file?: boolean;
}

// ── Parser (verbatim port) ───────────────────────────────────────────────────

function parsePatchHeader(
	lines: string[],
	startIdx: number,
): { filePath: string; movePath?: string; nextIdx: number } | null {
	const line = lines[startIdx];

	if (line.startsWith("*** Add File:")) {
		const filePath = line.slice("*** Add File:".length).trim();
		return filePath ? { filePath, nextIdx: startIdx + 1 } : null;
	}
	if (line.startsWith("*** Delete File:")) {
		const filePath = line.slice("*** Delete File:".length).trim();
		return filePath ? { filePath, nextIdx: startIdx + 1 } : null;
	}
	if (line.startsWith("*** Update File:")) {
		const filePath = line.slice("*** Update File:".length).trim();
		let movePath: string | undefined;
		let nextIdx = startIdx + 1;
		if (nextIdx < lines.length && lines[nextIdx].startsWith("*** Move to:")) {
			movePath = lines[nextIdx].slice("*** Move to:".length).trim();
			nextIdx++;
		}
		return filePath ? { filePath, movePath, nextIdx } : null;
	}
	return null;
}

function parseUpdateFileChunks(lines: string[], startIdx: number): { chunks: UpdateFileChunk[]; nextIdx: number } {
	const chunks: UpdateFileChunk[] = [];
	let i = startIdx;

	while (i < lines.length && !lines[i].startsWith("***")) {
		if (lines[i].startsWith("@@")) {
			const contextLine = lines[i].substring(2).trim();
			i++;

			const oldLines: string[] = [];
			const newLines: string[] = [];
			let isEndOfFile = false;

			while (i < lines.length && !lines[i].startsWith("@@") && !lines[i].startsWith("***")) {
				const changeLine = lines[i];

				if (changeLine === "*** End of File") {
					isEndOfFile = true;
					i++;
					break;
				}
				if (changeLine.startsWith(" ")) {
					const content = changeLine.substring(1);
					oldLines.push(content);
					newLines.push(content);
				} else if (changeLine.startsWith("-")) {
					oldLines.push(changeLine.substring(1));
				} else if (changeLine.startsWith("+")) {
					newLines.push(changeLine.substring(1));
				}
				i++;
			}

			chunks.push({
				old_lines: oldLines,
				new_lines: newLines,
				change_context: contextLine || undefined,
				is_end_of_file: isEndOfFile || undefined,
			});
		} else {
			i++;
		}
	}

	return { chunks, nextIdx: i };
}

function parseAddFileContent(lines: string[], startIdx: number): { content: string; nextIdx: number } {
	let content = "";
	let i = startIdx;

	while (i < lines.length && !lines[i].startsWith("***")) {
		if (lines[i].startsWith("+")) {
			content += lines[i].substring(1) + "\n";
		}
		i++;
	}
	if (content.endsWith("\n")) {
		content = content.slice(0, -1);
	}
	return { content, nextIdx: i };
}

function stripHeredoc(input: string): string {
	const heredocMatch = input.match(/^(?:cat\s+)?<<['"]?(\w+)['"]?\s*\n([\s\S]*?)\n\1\s*$/);
	if (heredocMatch) return heredocMatch[2];
	return input;
}

function parsePatch(patchText: string): { hunks: Hunk[] } {
	const cleaned = stripHeredoc(patchText.trim());
	const lines = cleaned.split("\n");
	const hunks: Hunk[] = [];
	let i = 0;

	const beginIdx = lines.findIndex((line) => line.trim() === "*** Begin Patch");
	const endIdx = lines.findIndex((line) => line.trim() === "*** End Patch");

	if (beginIdx === -1 || endIdx === -1 || beginIdx >= endIdx) {
		throw new Error("Invalid patch format: missing Begin/End markers");
	}

	i = beginIdx + 1;
	while (i < endIdx) {
		const header = parsePatchHeader(lines, i);
		if (!header) {
			i++;
			continue;
		}

		if (lines[i].startsWith("*** Add File:")) {
			const { content, nextIdx } = parseAddFileContent(lines, header.nextIdx);
			hunks.push({ type: "add", path: header.filePath, contents: content });
			i = nextIdx;
		} else if (lines[i].startsWith("*** Delete File:")) {
			hunks.push({ type: "delete", path: header.filePath });
			i = header.nextIdx;
		} else if (lines[i].startsWith("*** Update File:")) {
			const { chunks, nextIdx } = parseUpdateFileChunks(lines, header.nextIdx);
			hunks.push({ type: "update", path: header.filePath, move_path: header.movePath, chunks });
			i = nextIdx;
		} else {
			i++;
		}
	}

	return { hunks };
}

// ── Content derivation (verbatim port) ───────────────────────────────────────

function normalizeUnicode(str: string): string {
	return str
		.replace(/[‘’‚‛]/g, "'")
		.replace(/[“”„‟]/g, '"')
		.replace(/[‐‑‒–—―]/g, "-")
		.replace(/…/g, "...")
		.replace(/ /g, " ");
}

type Comparator = (a: string, b: string) => boolean;

function tryMatch(lines: string[], pattern: string[], startIndex: number, compare: Comparator, eof: boolean): number {
	if (eof) {
		const fromEnd = lines.length - pattern.length;
		if (fromEnd >= startIndex) {
			let matches = true;
			for (let j = 0; j < pattern.length; j++) {
				if (!compare(lines[fromEnd + j], pattern[j])) {
					matches = false;
					break;
				}
			}
			if (matches) return fromEnd;
		}
	}
	for (let i = startIndex; i <= lines.length - pattern.length; i++) {
		let matches = true;
		for (let j = 0; j < pattern.length; j++) {
			if (!compare(lines[i + j], pattern[j])) {
				matches = false;
				break;
			}
		}
		if (matches) return i;
	}
	return -1;
}

function seekSequence(lines: string[], pattern: string[], startIndex: number, eof = false): number {
	if (pattern.length === 0) return -1;
	const exact = tryMatch(lines, pattern, startIndex, (a, b) => a === b, eof);
	if (exact !== -1) return exact;
	const rstrip = tryMatch(lines, pattern, startIndex, (a, b) => a.trimEnd() === b.trimEnd(), eof);
	if (rstrip !== -1) return rstrip;
	const trim = tryMatch(lines, pattern, startIndex, (a, b) => a.trim() === b.trim(), eof);
	if (trim !== -1) return trim;
	return tryMatch(lines, pattern, startIndex, (a, b) => normalizeUnicode(a.trim()) === normalizeUnicode(b.trim()), eof);
}

function computeReplacements(
	originalLines: string[],
	filePath: string,
	chunks: UpdateFileChunk[],
): Array<[number, number, string[]]> {
	const replacements: Array<[number, number, string[]]> = [];
	let lineIndex = 0;

	for (const chunk of chunks) {
		if (chunk.change_context) {
			const contextIdx = seekSequence(originalLines, [chunk.change_context], lineIndex);
			if (contextIdx === -1) {
				throw new Error(`Failed to find context '${chunk.change_context}' in ${filePath}`);
			}
			lineIndex = contextIdx + 1;
		}

		if (chunk.old_lines.length === 0) {
			const insertionIdx =
				originalLines.length > 0 && originalLines[originalLines.length - 1] === ""
					? originalLines.length - 1
					: originalLines.length;
			replacements.push([insertionIdx, 0, chunk.new_lines]);
			continue;
		}

		let pattern = chunk.old_lines;
		let newSlice = chunk.new_lines;
		let found = seekSequence(originalLines, pattern, lineIndex, chunk.is_end_of_file);

		if (found === -1 && pattern.length > 0 && pattern[pattern.length - 1] === "") {
			pattern = pattern.slice(0, -1);
			if (newSlice.length > 0 && newSlice[newSlice.length - 1] === "") {
				newSlice = newSlice.slice(0, -1);
			}
			found = seekSequence(originalLines, pattern, lineIndex, chunk.is_end_of_file);
		}

		if (found !== -1) {
			replacements.push([found, pattern.length, newSlice]);
			lineIndex = found + pattern.length;
		} else {
			throw new Error(`Failed to find expected lines in ${filePath}:\n${chunk.old_lines.join("\n")}`);
		}
	}

	replacements.sort((a, b) => a[0] - b[0]);
	return replacements;
}

function applyReplacements(lines: string[], replacements: Array<[number, number, string[]]>): string[] {
	const result = [...lines];
	for (let i = replacements.length - 1; i >= 0; i--) {
		const [startIdx, oldLen, newSegment] = replacements[i];
		result.splice(startIdx, oldLen);
		for (let j = 0; j < newSegment.length; j++) {
			result.splice(startIdx + j, 0, newSegment[j]);
		}
	}
	return result;
}

function deriveNewContentsFromChunks(
	filePath: string,
	chunks: UpdateFileChunk[],
	originalText: string,
): { content: string } {
	let originalLines = originalText.split("\n");
	if (originalLines.length > 0 && originalLines[originalLines.length - 1] === "") {
		originalLines.pop();
	}

	const replacements = computeReplacements(originalLines, filePath, chunks);
	const newLines = applyReplacements(originalLines, replacements);

	if (newLines.length === 0 || newLines[newLines.length - 1] !== "") {
		newLines.push("");
	}

	return { content: newLines.join("\n") };
}

function generateUnifiedDiff(oldContent: string, newContent: string): string {
	const oldLines = oldContent.split("\n");
	const newLines = newContent.split("\n");
	let diff = "";
	const maxLen = Math.max(oldLines.length, newLines.length);
	let hasChanges = false;

	for (let i = 0; i < maxLen; i++) {
		const oldLine = oldLines[i];
		const newLine = newLines[i];
		if (oldLine !== newLine) {
			if (oldLine !== undefined) diff += `-${oldLine}\n`;
			if (newLine !== undefined) diff += `+${newLine}\n`;
			hasChanges = true;
		} else if (oldLine !== undefined) {
			diff += ` ${oldLine}\n`;
		}
	}
	return hasChanges ? diff : "";
}

// ── Pi tool wrapper ───────────────────────────────────────────────────────────

interface FileChange {
	filePath: string;
	type: "add" | "update" | "delete" | "move";
	movePath?: string;
	newContent?: string;
	diff: string;
}

interface ApplyPatchDetails {
	files: Array<{ relativePath: string; type: string; diff: string }>;
	applied: boolean;
	error?: string;
}

const ApplyPatchParams = Type.Object({
	patchText: Type.String({ description: "The full patch text that describes all changes to be made" }),
});

export default function applyPatch(pi: ExtensionAPI) {
	pi.registerTool({
		name: "apply_patch",
		label: "Apply Patch",
		description:
			'Apply a patch in the "*** Begin Patch" format to add, update, move, or delete one or more files in a single ' +
			"atomic operation. Prefer this over multiple edit/write calls when a change touches several files or does " +
			"file moves. Format:\n" +
			"*** Begin Patch\n" +
			"*** Add File: path/to/new.txt\n+line one\n+line two\n" +
			"*** Update File: path/to/existing.txt\n[*** Move to: path/to/renamed.txt]\n@@ optional context\n unchanged line\n-removed line\n+added line\n" +
			"*** Delete File: path/to/old.txt\n" +
			"*** End Patch",
		promptSnippet: "Apply a multi-file patch (add/update/move/delete) in one atomic operation",
		promptGuidelines: [
			"Use apply_patch instead of separate edit/write calls when a single change spans multiple files or renames a file.",
		],
		parameters: ApplyPatchParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			let hunks: Hunk[];
			try {
				hunks = parsePatch(params.patchText).hunks;
			} catch (error) {
				return {
					content: [{ type: "text", text: `apply_patch verification failed: ${error}` }],
					details: { files: [], applied: false, error: String(error) } as ApplyPatchDetails,
				};
			}

			if (hunks.length === 0) {
				return {
					content: [{ type: "text", text: "apply_patch verification failed: no hunks found" }],
					details: { files: [], applied: false, error: "no hunks found" } as ApplyPatchDetails,
				};
			}

			const cwd = ctx.cwd ?? process.cwd();
			const changes: FileChange[] = [];

			try {
				for (const hunk of hunks) {
					const filePath = resolve(cwd, hunk.path);

					if (hunk.type === "add") {
						const newContent = hunk.contents.endsWith("\n") || hunk.contents.length === 0 ? hunk.contents : `${hunk.contents}\n`;
						changes.push({
							filePath,
							type: "add",
							newContent,
							diff: generateUnifiedDiff("", newContent),
						});
					} else if (hunk.type === "delete") {
						if (!existsSync(filePath)) {
							throw new Error(`Failed to read file to delete: ${filePath}`);
						}
						const oldContent = readFileSync(filePath, "utf8");
						changes.push({
							filePath,
							type: "delete",
							diff: generateUnifiedDiff(oldContent, ""),
						});
					} else {
						if (!existsSync(filePath)) {
							throw new Error(`Failed to read file to update: ${filePath}`);
						}
						const oldContent = readFileSync(filePath, "utf8");
						const { content: newContent } = deriveNewContentsFromChunks(filePath, hunk.chunks, oldContent);
						const movePath = hunk.move_path ? resolve(cwd, hunk.move_path) : undefined;
						changes.push({
							filePath,
							type: movePath ? "move" : "update",
							movePath,
							newContent,
							diff: generateUnifiedDiff(oldContent, newContent),
						});
					}
				}
			} catch (error) {
				return {
					content: [{ type: "text", text: `apply_patch verification failed: ${error}` }],
					details: { files: [], applied: false, error: String(error) } as ApplyPatchDetails,
				};
			}

			const files = changes.map((c) => ({
				relativePath: relative(cwd, c.movePath ?? c.filePath).replaceAll("\\", "/"),
				type: c.type,
				diff: c.diff,
			}));

			if (ctx.mode === "tui") {
				const summary = files.map((f) => `${f.type[0].toUpperCase()} ${f.relativePath}`).join("\n");
				const ok = await ctx.ui.confirm("Apply patch?", summary);
				if (!ok) {
					return {
						content: [{ type: "text", text: "User declined to apply the patch" }],
						details: { files, applied: false, error: "declined" } as ApplyPatchDetails,
					};
				}
			}

			for (const change of changes) {
				switch (change.type) {
					case "add":
						mkdirSync(dirname(change.filePath), { recursive: true });
						writeFileSync(change.filePath, change.newContent ?? "");
						break;
					case "update":
						writeFileSync(change.filePath, change.newContent ?? "");
						break;
					case "move":
						mkdirSync(dirname(change.movePath!), { recursive: true });
						writeFileSync(change.movePath!, change.newContent ?? "");
						rmSync(change.filePath);
						break;
					case "delete":
						rmSync(change.filePath);
						break;
				}
			}

			const summaryLines = changes.map((c) => {
				const rel = relative(cwd, c.movePath ?? c.filePath).replaceAll("\\", "/");
				if (c.type === "add") return `A ${rel}`;
				if (c.type === "delete") return `D ${rel}`;
				return `M ${rel}`;
			});

			return {
				content: [{ type: "text", text: `Success. Updated the following files:\n${summaryLines.join("\n")}` }],
				details: { files, applied: true } as ApplyPatchDetails,
			};
		},

		renderCall(args, theme, _context) {
			const text = String(args.patchText ?? "");
			const fileLines = text
				.split("\n")
				.filter((l) => l.startsWith("*** Add File:") || l.startsWith("*** Update File:") || l.startsWith("*** Delete File:"));
			return new Text(
				theme.fg("toolTitle", theme.bold("apply_patch ")) + theme.fg("muted", `${fileLines.length} file(s)`),
				0,
				0,
			);
		},

		renderResult(result, _options, theme, _context) {
			const details = result.details as ApplyPatchDetails | undefined;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}
			if (details.error) {
				return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);
			}
			const lines = details.files.map((f) => `${f.type[0].toUpperCase()} ${f.relativePath}`);
			return new Text(theme.fg("success", "✓ ") + theme.fg("muted", lines.join(", ")), 0, 0);
		},
	});
}

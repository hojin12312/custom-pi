/**
 * ImageRead - Send a local image through the Studio oMLX VLM backend.
 *
 * Ported from ~/.config/opencode/tools/imageread.ts. The text-only coding
 * models use this tool to inspect screenshots, charts, and other image files.
 * (2026-08-06 MBP vision server :8110 폐기 → Studio oMLX :8080 VLM으로 이관)
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { Type } from "typebox";

const execFileAsync = promisify(execFile);

const SERVER_URL =
	process.env.IMAGEREAD_VLM_URL ??
	"http://localhost:8080/v1/chat/completions";
const MODEL_ID =
	process.env.IMAGEREAD_VLM_MODEL ??
	"qwen3.6-35b-a3b-4bit";
const API_KEY = process.env.IMAGEREAD_VLM_API_KEY ?? "";

interface CropRegion {
	x: number;
	y: number;
	w: number;
	h: number;
}

interface ImageReadDetails {
	mode?: string;
	source?: string;
	read?: string;
	error?: string;
}

const ImageReadParams = Type.Object({
	path: Type.String({ description: "Path to the image file (absolute, or relative to the session working directory)" }),
	instruction: Type.Optional(
		Type.String({ description: "What to look for or read. Defaults to: Explain this image in detail." }),
	),
	detail: Type.Optional(
		Type.Union([Type.Literal("low"), Type.Literal("high")], {
			description: "low = full image at about 1MP (default); high = tile large images for full-resolution detail.",
		}),
	),
	crop: Type.Optional(
		Type.Object({
			x: Type.Number({ description: "Left edge of the crop region, normalized 0-1000" }),
			y: Type.Number({ description: "Top edge of the crop region, normalized 0-1000" }),
			w: Type.Number({ description: "Width of the crop region, normalized 0-1000" }),
			h: Type.Number({ description: "Height of the crop region, normalized 0-1000" }),
		}, { description: "Optional crop region in normalized 0-1000 coordinates of the original image." }),
	),
});

function parseSize(output: string): { w: number; h: number } {
	const w = Number(output.match(/pixelWidth:\s*(\d+)/)?.[1] ?? "0");
	const h = Number(output.match(/pixelHeight:\s*(\d+)/)?.[1] ?? "0");
	return { w, h };
}

async function runSips(args: string[], signal?: AbortSignal): Promise<string> {
	const result = await execFileAsync("sips", args, {
		maxBuffer: 1024 * 1024,
		signal,
	});
	return String(result.stdout).trim();
}

async function askVlm(imagePath: string, instruction: string, signal?: AbortSignal): Promise<string> {
	const image = await readFile(imagePath);
	const body = {
		model: MODEL_ID,
		messages: [
			{
				role: "user",
				content: [
					{ type: "text", text: instruction },
					{
						type: "image_url",
						image_url: { url: `data:image/jpeg;base64,${image.toString("base64")}` },
					},
				],
			},
		],
		max_tokens: 1024,
		temperature: 0.1,
	};

	const response = await fetch(SERVER_URL, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"X-Client-Id": "pi",
			...(API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {}),
		},
		body: JSON.stringify(body),
		signal: signal ?? AbortSignal.timeout(300_000),
	});

	if (!response.ok) {
		const error = await response.text().catch(() => "");
		throw new Error(`VLM server ${response.status}: ${error.slice(0, 300)}`);
	}

	const data = (await response.json()) as {
		choices?: Array<{ message?: { content?: unknown } }>;
	};
	const content = data.choices?.[0]?.message?.content;
	return typeof content === "string" ? content.trim() : "";
}

function clamp(value: number): number {
	return Math.max(0, Math.min(1000, value));
}

function cropPixels(crop: CropRegion, origW: number, origH: number) {
	const x = Math.round((clamp(crop.x) / 1000) * origW);
	const y = Math.round((clamp(crop.y) / 1000) * origH);
	const w = Math.round((clamp(crop.w) / 1000) * origW);
	const h = Math.round((clamp(crop.h) / 1000) * origH);
	const x2 = Math.min(origW, x + w);
	const y2 = Math.min(origH, y + h);
	return {
		x,
		y,
		w: Math.max(1, x2 - x),
		h: Math.max(1, y2 - y),
	};
}

function syncActiveToolForModel(pi: ExtensionAPI, ctx: ExtensionContext): void {
	const isVisionModel = ctx.model?.input?.includes("image") === true;
	const activeTools = pi.getActiveTools();
	const nextTools = isVisionModel
		? activeTools.filter((name) => name !== "imageread")
		: activeTools.includes("imageread")
			? activeTools
			: [...activeTools, "imageread"];

	const unchanged = activeTools.length === nextTools.length && activeTools.every((name, index) => name === nextTools[index]);
	if (!unchanged) pi.setActiveTools(nextTools);
}

async function readImage(
	imagePath: string,
	params: { instruction: string; detail?: "low" | "high"; crop?: CropRegion },
	signal?: AbortSignal,
): Promise<{ text: string; details: ImageReadDetails }> {
	const tempDir = mkdtempSync(path.join(tmpdir(), "imageread-"));
	try {
		const sizeOutput = await runSips(["-g", "pixelWidth", "-g", "pixelHeight", imagePath], signal);
		const { w: origW, h: origH } = parseSize(sizeOutput);
		if (!origW || !origH) throw new Error(`Not a readable image file: ${imagePath}`);

		if (params.crop) {
			const crop = cropPixels(params.crop, origW, origH);
			const outputPath = path.join(tempDir, "crop.jpg");
			await runSips([
				"-c", String(crop.h), String(crop.w),
				"--cropOffset", String(crop.y), String(crop.x),
				"-s", "format", "jpeg", "-s", "formatOptions", "85",
				imagePath, "--out", outputPath,
			], signal);
			const text = await askVlm(outputPath, params.instruction, signal);
			return {
				text: `mode: crop (x=${params.crop.x}, y=${params.crop.y}, w=${params.crop.w}, h=${params.crop.h} normalized)\nsource: ${origW}x${origH}\nread: ${crop.w}x${crop.h}\n---\n${text}`,
				details: { mode: "crop", source: `${origW}x${origH}`, read: `${crop.w}x${crop.h}` },
			};
		}

		if (params.detail === "high") {
			const maxDim = Math.max(origW, origH);
			if (maxDim <= 2048) {
				const outputPath = path.join(tempDir, "full.jpg");
				await runSips(["-s", "format", "jpeg", "-s", "formatOptions", "85", imagePath, "--out", outputPath], signal);
				const text = await askVlm(outputPath, params.instruction, signal);
				return {
					text: `mode: high\nsource: ${origW}x${origH}\nread: ${origW}x${origH}\n---\n${text}`,
					details: { mode: "high", source: `${origW}x${origH}`, read: `${origW}x${origH}` },
				};
			}

			const grid = maxDim > 5120 ? 4 : maxDim > 2560 ? 3 : 2;
			const tileW = Math.ceil(origW / grid);
			const tileH = Math.ceil(origH / grid);
			const tileCalls: Promise<string>[] = [];
			for (let row = 0; row < grid; row++) {
				for (let col = 0; col < grid; col++) {
					const x = col * tileW;
					const y = row * tileH;
					const w = Math.min(origW - x, tileW);
					const h = Math.min(origH - y, tileH);
					const outputPath = path.join(tempDir, `tile-${row}-${col}.jpg`);
					tileCalls.push((async () => {
						await runSips([
							"-c", String(h), String(w),
							"--cropOffset", String(y), String(x),
							"-s", "format", "jpeg", "-s", "formatOptions", "85",
							imagePath, "--out", outputPath,
						], signal);
						const text = await askVlm(
							outputPath,
							`${params.instruction}\n(This is tile ${row * grid + col + 1}/${grid * grid} of the full image, row ${row + 1} col ${col + 1}.)`,
							signal,
						);
						return `tile ${row * grid + col + 1}/${grid * grid}: ${text}`;
					})());
				}
			}
			const parts = await Promise.all(tileCalls);
			return {
				text: `mode: high (tiled ${grid}x${grid})\nsource: ${origW}x${origH}\nread: full (tiled)\n---\n${parts.join("\n\n")}`,
				details: { mode: `high (tiled ${grid}x${grid})`, source: `${origW}x${origH}`, read: "full (tiled)" },
			};
		}

		const outputPath = path.join(tempDir, "low.jpg");
		await runSips([
			"-Z", "1280",
			"-s", "format", "jpeg", "-s", "formatOptions", "85",
			imagePath, "--out", outputPath,
		], signal);
		const { w: readW, h: readH } = parseSize(await runSips(["-g", "pixelWidth", "-g", "pixelHeight", outputPath], signal));
		const text = await askVlm(outputPath, params.instruction, signal);
		return {
			text: `mode: low\nsource: ${origW}x${origH}\nread: ${readW}x${readH}\n---\n${text}`,
			details: { mode: "low", source: `${origW}x${origH}`, read: `${readW}x${readH}` },
		};
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
}

export default function imageRead(pi: ExtensionAPI) {
	// Extensions are discovered before model selection, so keep the module loaded
	// but expose the tool only to text-only models. The before_agent_start hook
	// also covers the initial model, while model_select handles later switches.
	pi.on("model_select", (_event, ctx) => syncActiveToolForModel(pi, ctx));
	pi.on("before_agent_start", (_event, ctx) => syncActiveToolForModel(pi, ctx));

	pi.registerTool({
		name: "imageread",
		label: "ImageRead",
		description:
			"Analyze an image file using the local vision model. Use this whenever the user asks about an image or image file because the text-only model cannot inspect pixels directly. Start with detail=low for the whole image; use crop for small text, charts, or screenshots after inspecting the source dimensions. Use detail=high for large images that require tiled full-resolution reading.",
		promptSnippet: "Read image files through the local vision model; start low, then crop for fine detail",
		promptGuidelines: [
			"Use imageread whenever the task requires inspecting pixels in an image file. Start with detail=low; use the returned source dimensions to request a normalized crop for small text or regions.",
			"Use detail=high for large images when full-resolution coverage is needed. Do not claim visual details that have not been checked with imageread.",
		],
		parameters: ImageReadParams,
		executionMode: "sequential",

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const cwd = ctx.cwd ?? process.cwd();
			const imagePath = path.isAbsolute(params.path) ? params.path : path.resolve(cwd, params.path);
			const instruction = params.instruction?.trim() || "Explain this image in detail.";

			try {
				if (!existsSync(imagePath)) throw new Error(`Image not found: ${imagePath}`);
				const result = await readImage(imagePath, { instruction, detail: params.detail, crop: params.crop }, signal);
				return { content: [{ type: "text", text: result.text }], details: result.details };
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					content: [{ type: "text", text: `ImageRead failed: ${message}` }],
					isError: true,
					details: { error: message },
				};
			}
		},
	});
}

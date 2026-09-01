import { MessageId } from "@deepseek-ai/dsh-llm";
import Schema from "@deepseek-ai/schemastery";
import { settingsNamespace } from "@deepseek-ai/dsh-settings";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
//#region src/settings.ts
/**
* Settings namespace schema for `mediaStudio`. Every user-tunable field lives
* here (provider baseURL + apiKey + default model), exposed in the DSH
* Settings UI just like other plugins' prefs. Code reads the resolved
* value through the registered `SettingsScope<T>`.
*
* Roles:
*   `role('secret')`  — stripped from network/redacted descriptions and
*                        encrypted in `~/.dsh/settings.yaml`. Plugin code
*                        still receives the verbatim value at runtime.
*
* Defaults are applied via `.default(...)` on individual leaf schemas so
* a partially-populated user section (e.g. only image provider filled)
* still validates cleanly against the full schema.
*/
const MediaProviderSchema = Schema.object({
	/** Provider route, e.g. "deepseek", "openai", "custom-agnes". */
	provider: Schema.string().default("").description("Provider route as registered with ctx.llm (or \"custom-*\" for user-added media APIs)."),
	/** API base URL — required for "custom-*" providers. */
	baseURL: Schema.string().default("").description("API endpoint for \"custom-*\" providers (Agnes, MiniMax, OpenAI-compat, etc)."),
	/** Auth bearer; role('secret') so it is redacted on the wire. */
	apiKey: Schema.string().role("secret").default("").description("Bearer / API key for the custom provider."),
	/** Default model to use when the node does not specify one. */
	defaultModel: Schema.string().default("").description("Default model id used when a canvas node leaves the model field blank.")
});
const MediaMusicProviderSchema = Schema.object({
	provider: Schema.string().default(""),
	baseURL: Schema.string().default(""),
	apiKey: Schema.string().role("secret").default(""),
	defaultModel: Schema.string().default(""),
	voice: Schema.string().default("male-qn-jingying").description("Voice preset id for TTS (MiniMax Speech 02 HD etc.).")
});
const MediaStudioSettings = Schema.object({
	/** Default text model the canvas `text` node uses. Auto-resolved from `ctx.llm` if blank. */
	textModel: Schema.string().default("").description("Default text model id (e.g. \"deepseek/deepseek-chat\"). Leave blank to auto-pick."),
	image: MediaProviderSchema.default({
		provider: "custom-agnes",
		baseURL: "https://apihub.agnes-ai.com/v1",
		apiKey: "",
		defaultModel: "agnes-image-2.1-flash"
	}),
	video: MediaProviderSchema.default({
		provider: "custom-agnes",
		baseURL: "https://apihub.agnes-ai.com/v1",
		apiKey: "",
		defaultModel: "agnes-video-2.5-flash"
	}),
	music: MediaMusicProviderSchema.default({
		provider: "custom-minimax",
		baseURL: "https://api.minimaxi.com",
		apiKey: "",
		defaultModel: "speech-02-hd",
		voice: "male-qn-jingying"
	})
});
const NS = settingsNamespace("media-studio");
/** Default values when no user section is on disk. Keep in sync with the
*  `.default(...)` calls above — `.get()` returns these when the section
*  is empty, so anything reading the shape synchronously without going
*  through the harness sees the same defaults. */
const DEFAULT_MEDIA_STUDIO = {
	textModel: "",
	image: {
		provider: "custom-agnes",
		baseURL: "https://apihub.agnes-ai.com/v1",
		apiKey: "",
		defaultModel: "agnes-image-2.1-flash"
	},
	video: {
		provider: "custom-agnes",
		baseURL: "https://apihub.agnes-ai.com/v1",
		apiKey: "",
		defaultModel: "agnes-video-2.5-flash"
	},
	music: {
		provider: "custom-minimax",
		baseURL: "https://api.minimaxi.com",
		apiKey: "",
		defaultModel: "speech-02-hd",
		voice: "male-qn-jingying"
	}
};
/** Read the live resolved value through the SettingsScope handle. Returns
*  DEFAULT_MEDIA_STUDIO if the scope is missing (boot-time code paths). */
function readMediaStudio(scope) {
	if (!scope) return DEFAULT_MEDIA_STUDIO;
	try {
		return scope.get();
	} catch {
		return DEFAULT_MEDIA_STUDIO;
	}
}
//#endregion
//#region src/config.ts
const Config = Schema.object({
	workspaceRoot: Schema.string().default("~/.franklin/media-studio").description("Directory for canvas + generated media. Created on first write."),
	defaultCanvasId: Schema.string().default("main").description("Canvas id every session is bound to unless it overrides."),
	logToolCalls: Schema.boolean().default(true).description("Append every canvas/media tool result to the session log for replay.")
});
//#endregion
//#region src/llm-bridge.ts
/**
* Send one prompt to the configured LLM and collect the streamed text.
*
* Why a thin wrapper?
*   The harness's `LlmRuntime.stream(...)` is an async iterable of
*   `StreamChunk` events. Tools must return canonical JSON values (not
*   strings), so callers expect a synchronous-looking object. This
*   helper drains the stream into a single `{ text, model, usage }` so
*   tool code stays a one-liner.
*
* Cancellation:
*   We respect the tool exec's AbortSignal. If it aborts mid-stream,
*   the adapter will surface the abort and we propagate as a thrown
*   DOMException; the DSH tools pipeline turns it into an `isError`
*   result, never a silent half-answer.
*/
async function callLlm(llm, provider, model, prompt, signal) {
	if (!llm) throw new Error("dsh-media-studio: ctx.llm is not bound — the harness is running without an LLM adapter. Check `~/.dsh/settings.yaml`.");
	const t0 = Date.now();
	const prep = await llm.prepareCall({
		provider,
		model,
		maxTokens: 4096
	}, signal);
	let text = "";
	let usage = {
		inputTokens: 0,
		outputTokens: 0
	};
	let resolvedModel = `${provider}/${model}`;
	for await (const chunk of prep.stream({
		provider,
		model,
		messages: [{
			id: MessageId(`media-studio:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`),
			role: "user",
			content: [{
				type: "text",
				text: prompt
			}],
			source: { kind: "user" }
		}]
	})) switch (chunk.type) {
		case "text-delta":
			text += chunk.text;
			break;
		case "usage": usage = {
			inputTokens: chunk.usage.inputTokens,
			outputTokens: chunk.usage.outputTokens
		};
	}
	return {
		text,
		model: resolvedModel,
		usage,
		latencyMs: Date.now() - t0
	};
}
//#endregion
//#region src/media-providers.ts
/**
* Minimal fetch wrapper that:
*   - sets `Authorization: Bearer <key>` when the key is non-empty
*   - serializes JSON body when an object is passed
*   - throws a typed `MediaError` on non-2xx
*
* Provider endpoints that are not yet implemented in this client throw
* `MediaError('not-supported')` rather than silently 404 — the tool layer
* surfaces that to the user as a clear configuration mistake.
*/
async function postJSON(cfg, path, body, signal) {
	if (!cfg.baseURL) throw new MediaError("missing-baseurl", `provider "${cfg.provider}" has no baseURL configured (mediaStudio.${cfg.provider}.baseURL)`);
	const url = `${cfg.baseURL.replace(/\/+$/, "")}${path}`;
	const headers = { "Content-Type": "application/json" };
	if (cfg.apiKey) headers["Authorization"] = `Bearer ${cfg.apiKey}`;
	const res = await fetch(url, {
		method: "POST",
		headers,
		body: JSON.stringify(body),
		signal
	});
	if (!res.ok) {
		const text = await res.text().catch(() => "");
		throw new MediaError("http-" + res.status, `${cfg.provider} ${path} → HTTP ${res.status}: ${text.slice(0, 300)}`);
	}
	return await res.json();
}
async function getJSON(cfg, path, signal) {
	if (!cfg.baseURL) throw new MediaError("missing-baseurl", `provider "${cfg.provider}" has no baseURL configured`);
	const url = `${cfg.baseURL.replace(/\/+$/, "")}${path}`;
	const headers = {};
	if (cfg.apiKey) headers["Authorization"] = `Bearer ${cfg.apiKey}`;
	const res = await fetch(url, {
		method: "GET",
		headers,
		signal
	});
	if (!res.ok) {
		const text = await res.text().catch(() => "");
		throw new MediaError("http-" + res.status, `${cfg.provider} GET ${path} → HTTP ${res.status}: ${text.slice(0, 300)}`);
	}
	return await res.json();
}
/** Save a remote URL to disk; ensure parent dir exists. */
async function downloadTo(url, dest, signal) {
	await mkdir(dirname(dest), { recursive: true });
	const r = await fetch(url, { signal });
	if (!r.ok) throw new MediaError("download-" + r.status, `failed to download media: HTTP ${r.status}`);
	const buf = Buffer.from(await r.arrayBuffer());
	await writeFile(dest, buf);
	return buf.length;
}
/**
* Pick the right extension for a downloaded file. Most providers send a
* `Content-Type` header; we fall back to a path-extension hint when not.
*/
function guessExt(url, contentType) {
	if (contentType) {
		const ct = contentType.toLowerCase();
		if (ct.includes("png")) return "png";
		if (ct.includes("jpeg") || ct.includes("jpg")) return "jpg";
		if (ct.includes("webp")) return "webp";
		if (ct.includes("mp4")) return "mp4";
		if (ct.includes("mpeg") || ct.includes("mp3")) return "mp3";
		if (ct.includes("wav")) return "wav";
	}
	return extname(new URL(url, "http://x").pathname).slice(1).toLowerCase() || "bin";
}
/**
* Errors from the media layer. The `code` is stable; `message` is for the
* user. Tool code lets `instanceof MediaError` decide whether to mark a
* failed result as `isError` (the registry does that for any thrown value).
*/
var MediaError = class extends Error {
	code;
	constructor(code, message) {
		super(message);
		this.code = code;
		this.name = "MediaError";
	}
};
/**
* Pull the first URL out of an OpenAI-style generations response. Accepts
* `{ data: [{ url }] }`, `{ url }`, or `{ data: [{ b64_json }] }` (the last
* case is rare but OpenAI uses it on edits).
*/
function firstMediaUrl(json) {
	if (!json || typeof json !== "object") throw new MediaError("bad-shape", "provider returned non-JSON");
	const root = json;
	if (typeof root.url === "string") return root.url;
	const data = root.data;
	if (Array.isArray(data) && data.length > 0) {
		const first = data[0];
		if (typeof first.url === "string") return first.url;
		if (typeof first.b64_json === "string") {
			Buffer.from(first.b64_json, "base64");
			throw new MediaError("not-supported", "provider returned b64_json; the plugin only handles URL outputs for now");
		}
	}
	throw new MediaError("bad-shape", "no `url` field in provider response");
}
/** Pull the first job id out of an OpenAI-style video submit response. */
function firstVideoId(json) {
	if (!json || typeof json !== "object") throw new MediaError("bad-shape", "provider returned non-JSON");
	const root = json;
	const id = root.id ?? root.video_id ?? root.task_id;
	if (typeof id === "string" && id) return id;
	throw new MediaError("bad-shape", "no `id`/`video_id` in video submit response");
}
/** Pull a job status + URL out of a video poll response (best-effort). */
function pollVideoStatus(json) {
	if (!json || typeof json !== "object") return { status: "unknown" };
	const root = json;
	const status = String(root.status ?? root.state ?? "unknown");
	const url = root.url ?? root.video_url ?? root.data;
	return {
		status,
		url: typeof url === "string" ? url : void 0
	};
}
/**
* POST /images/generations (OpenAI spec). Agnes, OpenAI, xAI Grok, and any
* other provider that follows the OpenAI image schema can use this path.
*/
async function generateImage(cfg, opts) {
	const t0 = Date.now();
	const model = opts.model || cfg.defaultModel;
	if (!model) throw new MediaError("missing-model", `provider "${cfg.provider}" has no defaultModel configured`);
	const url = firstMediaUrl(await postJSON(cfg, "/images/generations", {
		model,
		prompt: opts.prompt,
		n: 1,
		...opts.size ? { size: opts.size } : {},
		...opts.aspectRatio ? { size: aspectRatioToSize(opts.aspectRatio) } : {},
		...opts.refImages && opts.refImages.length ? { image: opts.refImages } : {}
	}, opts.signal));
	const ext = guessExt(url);
	const outPath = ensureExt(opts.outPath, ext);
	return {
		url: outPath,
		model,
		bytes: await downloadTo(url, outPath, opts.signal),
		latencyMs: Date.now() - t0
	};
}
function aspectRatioToSize(ar) {
	switch (ar) {
		case "1:1": return "1024x1024";
		case "16:9": return "1792x1024";
		case "9:16": return "1024x1792";
		case "4:3": return "1536x1152";
		case "3:4": return "1152x1536";
	}
}
function ensureExt(path, ext) {
	const cur = extname(path).slice(1).toLowerCase();
	if (cur && cur !== "bin") return path;
	return join(dirname(path), `${extname(path).slice(1) ? "" : "media."}${ext === "bin" ? "" : ext}`.replace("media.media", "media")).replace(/^media\.(media\.)/, "media.") || path;
}
const VIDEO_POLL_MS = 5e3;
const VIDEO_TIMEOUT_MS = 15e5;
/**
* POST /videos/generations, then poll GET /videos/{id} until the provider
* returns status='completed' (or 'success') with a URL.
*
* Provider variance note:
*   Agnes returns { video_id, status: 'queued'/'in_progress'/'completed', url? }
*   OpenAI Sora returns { id, status: 'queued'/'in_progress'/'completed', ... }
*   Other providers may name the field differently — we try a few keys
*   before failing.
*/
async function generateVideo(cfg, opts) {
	const t0 = Date.now();
	const model = opts.model || cfg.defaultModel;
	if (!model) throw new MediaError("missing-model", `provider "${cfg.provider}" has no defaultModel configured`);
	const id = firstVideoId(await postJSON(cfg, "/videos/generations", {
		model,
		prompt: opts.prompt,
		...opts.aspectRatio ? { aspect_ratio: opts.aspectRatio } : {},
		...opts.durationS ? { duration_seconds: opts.durationS } : {},
		...opts.refImages && opts.refImages.length ? { image_url: opts.refImages[0] } : {}
	}, opts.signal));
	const deadline = Date.now() + VIDEO_TIMEOUT_MS;
	let videoUrl;
	while (Date.now() < deadline) {
		await sleep(VIDEO_POLL_MS, opts.signal);
		let polled;
		try {
			polled = pollVideoStatus(await getJSON(cfg, `/videos/${encodeURIComponent(id)}`, opts.signal));
		} catch {
			polled = { status: "unknown" };
		}
		if (polled.url) {
			videoUrl = polled.url;
			break;
		}
		if (polled.status === "failed" || polled.status === "error" || polled.status === "cancelled") throw new MediaError("video-failed", `${cfg.provider} video ${id} status=${polled.status}`);
	}
	if (!videoUrl) throw new MediaError("video-timeout", `${cfg.provider} video ${id} did not complete within ${VIDEO_TIMEOUT_MS / 1e3}s`);
	const ext = guessExt(videoUrl, "video/mp4");
	const outPath = ensureExt(opts.outPath, ext);
	return {
		url: outPath,
		model,
		bytes: await downloadTo(videoUrl, outPath, opts.signal),
		latencyMs: Date.now() - t0
	};
}
/**
* POST /audio/speech (OpenAI TTS spec). Agnes doesn't expose a TTS endpoint;
* MiniMax Speech 02 HD is OpenAI-compatible on this route — we send the
* MiniMax-shaped body and it Just Works for that provider.
*
* Returns the path to the saved audio file (mp3 by default).
*/
async function generateMusic(cfg, opts) {
	const t0 = Date.now();
	const model = cfg.defaultModel;
	if (!model) throw new MediaError("missing-model", `provider "${cfg.provider}" has no defaultModel configured`);
	if (!opts.text || !opts.text.trim()) throw new MediaError("empty-text", "TTS requires non-empty text");
	const body = {
		model,
		input: opts.text,
		voice: opts.voice || cfg.voice,
		response_format: "mp3",
		speed: opts.speed ?? 1
	};
	const url = `${cfg.baseURL.replace(/\/+$/, "")}/audio/speech`;
	const headers = {};
	if (cfg.apiKey) headers["Authorization"] = `Bearer ${cfg.apiKey}`;
	const res = await fetch(url, {
		method: "POST",
		headers,
		body: JSON.stringify(body),
		signal: opts.signal
	});
	if (!res.ok) {
		const t = await res.text().catch(() => "");
		throw new MediaError("http-" + res.status, `${cfg.provider} TTS → HTTP ${res.status}: ${t.slice(0, 300)}`);
	}
	const ct = res.headers.get("content-type") || "";
	if (!ct.startsWith("audio/")) {
		const t = await res.text().catch(() => "");
		throw new MediaError("bad-content-type", `${cfg.provider} TTS returned content-type=${ct || "unknown"}, body: ${t.slice(0, 200)}`);
	}
	await mkdir(dirname(opts.outPath), { recursive: true });
	const buf = Buffer.from(await res.arrayBuffer());
	await writeFile(opts.outPath, buf);
	return {
		url: opts.outPath,
		model,
		bytes: buf.length,
		latencyMs: Date.now() - t0
	};
}
function sleep(ms, signal) {
	return new Promise((resolve, reject) => {
		const t = setTimeout(resolve, ms);
		if (signal) {
			const onAbort = () => {
				clearTimeout(t);
				reject(new MediaError("aborted", "aborted during sleep"));
			};
			if (signal.aborted) onAbort();
			else signal.addEventListener("abort", onAbort, { once: true });
		}
	});
}
//#endregion
//#region src/tools.ts
/**
* Resolve the mediaStudio settings into a per-modality config object the
* media-providers.ts client can consume. Falls back to DEFAULT_MEDIA_STUDIO
* when the user section is empty so first-run works out of the box.
*/
function pickProvider(kind) {
	return ctxMediaStudio().getSettings()[kind];
}
function pickMusic() {
	return ctxMediaStudio().getSettings().music;
}
let _ctx = null;
function ctxMediaStudio() {
	if (!_ctx) throw new MediaError("not-initialized", "media-studio tools were called before apply() ran");
	return _ctx;
}
/** Bound at apply() so the tool closures can read `ctx.mediaStudio`. */
function bindMediaStudioContext(ctx) {
	_ctx = ctx;
}
const okImageOutput = {
	schema: { oneOf: [{
		type: "object",
		additionalProperties: false,
		properties: {
			ok: {
				type: "boolean",
				const: true
			},
			url: { type: "string" },
			model: { type: "string" },
			bytes: { type: "number" },
			latencyMs: { type: "number" },
			kind: {
				type: "string",
				const: "image"
			}
		}
	}, {
		type: "object",
		additionalProperties: false,
		properties: {
			ok: {
				type: "boolean",
				const: false
			},
			code: { type: "string" },
			message: { type: "string" },
			kind: {
				type: "string",
				const: "image"
			}
		}
	}] },
	render: (_args, value) => [{
		type: "text",
		text: value.ok ? `image generated: ${value.url}` : `image failed (${value.code}): ${value.message}`
	}]
};
const okVideoOutput = {
	schema: { oneOf: [{
		type: "object",
		additionalProperties: false,
		properties: {
			ok: {
				type: "boolean",
				const: true
			},
			url: { type: "string" },
			model: { type: "string" },
			bytes: { type: "number" },
			latencyMs: { type: "number" },
			kind: {
				type: "string",
				const: "video"
			}
		}
	}, {
		type: "object",
		additionalProperties: false,
		properties: {
			ok: {
				type: "boolean",
				const: false
			},
			code: { type: "string" },
			message: { type: "string" },
			kind: {
				type: "string",
				const: "video"
			}
		}
	}] },
	render: (_args, value) => [{
		type: "text",
		text: value.ok ? `video generated: ${value.url}` : `video failed (${value.code}): ${value.message}`
	}]
};
const okMusicOutput = {
	schema: { oneOf: [{
		type: "object",
		additionalProperties: false,
		properties: {
			ok: {
				type: "boolean",
				const: true
			},
			url: { type: "string" },
			model: { type: "string" },
			bytes: { type: "number" },
			latencyMs: { type: "number" },
			voice: { type: "string" },
			kind: {
				type: "string",
				const: "audio"
			}
		}
	}, {
		type: "object",
		additionalProperties: false,
		properties: {
			ok: {
				type: "boolean",
				const: false
			},
			code: { type: "string" },
			message: { type: "string" },
			voice: { type: "string" },
			kind: {
				type: "string",
				const: "audio"
			}
		}
	}] },
	render: (_args, value) => [{
		type: "text",
		text: value.ok ? `audio generated: ${value.url}` : `audio failed (${value.code}): ${value.message}`
	}]
};
function registerGenerateTextTool(ctx) {
	ctx.tools.register(defineTool({
		name: "generate_text",
		description: "Generate text via the harness-configured LLM. Uses whatever provider the user picked in DSH settings (DeepSeek / OpenAI / Anthropic / Agnes / etc.). Model id is the DSH-style \"<provider>/<model>\" pair, e.g. \"deepseek/deepseek-chat\".",
		parameters: {
			prompt: {
				type: "string",
				required: true,
				description: "The user prompt to send. Plain text only — multi-modal content blocks live behind separate tools."
			},
			model: {
				type: "string",
				description: "Optional \"<provider>/<model>\" override. If blank, uses mediaStudio.textModel from settings; if that is also blank, falls back to the harness default."
			},
			system: {
				type: "string",
				description: "Optional system prompt. Passed through to GenerateOptions.system (adapters map to the provider system slot)."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					text: { type: "string" },
					model: { type: "string" },
					usage: {
						type: "object",
						additionalProperties: false,
						properties: {
							inputTokens: { type: "number" },
							outputTokens: { type: "number" }
						}
					},
					latencyMs: { type: "number" }
				}
			},
			render: (_args, value) => [{
				type: "text",
				text: value.text || "(empty response)"
			}]
		},
		async execute(args, exec) {
			const mst = ctx.mediaStudio;
			const configured = (args.model?.trim() || mst.getSettings().textModel || "").trim();
			let provider = "";
			let model = configured;
			const slash = configured.indexOf("/");
			if (slash > 0) {
				provider = configured.slice(0, slash);
				model = configured.slice(slash + 1);
			}
			return callLlm(mst.llm, provider, model, args.system ? `${args.system}\n\n${args.prompt}` : args.prompt, exec.signal);
		}
	}));
}
function registerGenerateImageTool(ctx) {
	ctx.tools.register(defineTool({
		name: "generate_image",
		description: "Generate an image via the user-configured mediaStudio.image provider. Any OpenAI-compatible provider works (Agnes, OpenAI, xAI Grok, etc.). Provider config (baseURL / apiKey / defaultModel) is read live from the mediaStudio settings namespace.",
		parameters: {
			prompt: {
				type: "string",
				required: true,
				description: "Image prompt."
			},
			model: {
				type: "string",
				description: "Override mediaStudio.image.defaultModel for this call."
			},
			aspectRatio: {
				type: "string",
				enum: [
					"1:1",
					"16:9",
					"9:16",
					"4:3",
					"3:4"
				],
				description: "Optional aspect ratio. Mapped to OpenAI size when the provider honors it."
			},
			refImageUrls: {
				type: "array",
				items: { type: "string" },
				description: "Optional absolute URLs of reference images for image-to-image (multi-reference fusion). The provider may ignore this."
			}
		},
		output: okImageOutput,
		async execute(args, exec) {
			const cfg = pickProvider("image");
			const jobId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
			const outPath = join(workspaceRoot(), "web-jobs", `${jobId}.png`);
			try {
				const r = await generateImage(cfg, {
					prompt: args.prompt,
					model: args.model,
					aspectRatio: args.aspectRatio,
					refImages: Array.isArray(args.refImageUrls) ? args.refImageUrls : void 0,
					outPath,
					signal: exec.signal
				});
				return {
					ok: true,
					url: r.url,
					model: r.model,
					bytes: r.bytes,
					latencyMs: r.latencyMs,
					kind: "image"
				};
			} catch (e) {
				return errorResult(e, "image");
			}
		}
	}));
}
function registerGenerateVideoTool(ctx) {
	ctx.tools.register(defineTool({
		name: "generate_video",
		description: "Generate a short video via the user-configured mediaStudio.video provider. Submit+poll flow — the call may block 30-90s for typical 5s clips. Honor exec.signal for cancellation.",
		parameters: {
			prompt: {
				type: "string",
				required: true,
				description: "Video motion/scene prompt."
			},
			model: {
				type: "string",
				description: "Override mediaStudio.video.defaultModel."
			},
			aspectRatio: {
				type: "string",
				enum: [
					"16:9",
					"9:16",
					"1:1",
					"4:3",
					"3:4"
				]
			},
			durationS: {
				type: "number",
				description: "Integer 4-12s for most providers. Honored as-is."
			},
			refImageUrls: {
				type: "array",
				items: { type: "string" },
				description: "First frame reference (image-to-video)."
			}
		},
		output: okVideoOutput,
		async execute(args, exec) {
			const cfg = pickProvider("video");
			const jobId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
			const outPath = join(workspaceRoot(), "web-jobs", `${jobId}.mp4`);
			try {
				const r = await generateVideo(cfg, {
					prompt: args.prompt,
					model: args.model,
					aspectRatio: args.aspectRatio,
					durationS: args.durationS,
					refImages: Array.isArray(args.refImageUrls) ? args.refImageUrls : void 0,
					outPath,
					signal: exec.signal
				});
				return {
					ok: true,
					url: r.url,
					model: r.model,
					bytes: r.bytes,
					latencyMs: r.latencyMs,
					kind: "video"
				};
			} catch (e) {
				return errorResult(e, "video");
			}
		}
	}));
}
function registerGenerateMusicTool(ctx) {
	ctx.tools.register(defineTool({
		name: "generate_music",
		description: "Synthesize a voice clip via the user-configured mediaStudio.music provider (MiniMax TTS or any OpenAI-compat /audio/speech endpoint). Returns an mp3 file. Reads `text` as the literal text to speak aloud.",
		parameters: {
			text: {
				type: "string",
				required: true,
				description: "Literal text to speak aloud. NOT a song lyric — TTS reads this verbatim."
			},
			voice: {
				type: "string",
				description: "Voice preset id (e.g. \"male-qn-jingying\"). Falls back to mediaStudio.music.voice."
			},
			speed: {
				type: "number",
				description: "Speech speed 0.5–2.0. Default 1.0."
			}
		},
		output: okMusicOutput,
		async execute(args, exec) {
			const cfg = pickMusic();
			const jobId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
			const outPath = join(workspaceRoot(), "web-jobs", `${jobId}.mp3`);
			try {
				const r = await generateMusic(cfg, {
					text: args.text,
					voice: args.voice,
					speed: args.speed,
					outPath,
					signal: exec.signal
				});
				return {
					ok: true,
					url: r.url,
					model: r.model,
					bytes: r.bytes,
					latencyMs: r.latencyMs,
					voice: args.voice || cfg.voice,
					kind: "audio"
				};
			} catch (e) {
				return errorResult(e, "audio");
			}
		}
	}));
}
function errorResult(e, kind) {
	const code = e instanceof MediaError ? e.code : e instanceof Error ? "unknown" : "unknown";
	const message = e instanceof Error ? e.message : String(e);
	if (kind === "audio") return {
		ok: false,
		code,
		message,
		kind
	};
	return {
		ok: false,
		code,
		message,
		kind
	};
}
/** Resolve workspaceRoot from the plugin's cordis config. We read it back
*  from the ctx extension set in apply(). */
function workspaceRoot() {
	return ctxMediaStudio().workspaceRoot || `${process.env.HOME || "~"}/.franklin/media-studio`;
}
//#endregion
//#region src/index.ts
const name = "dsh-media-studio";
/**
* `settings` — register + watch the user-facing mediaStudio namespace.
* `llm` — read the harness-native LlmRuntime so text tools can use whatever
*         provider the user already configured in `~/.dsh/settings.yaml`.
* `tools` — register our canvas + media generation tools.
* `webServer` — register the SSE / HTTP routes the canvas tab subscribes to.
*/
const inject = [
	"settings",
	"llm",
	"tools",
	"webServer"
];
/**
* Lifecycle:
*   1. Register `mediaStudio` settings namespace (immutable schema; user fills).
*   2. Grab a typed scope handle for live reads.
*   3. Stash it on `ctx.mediaStudio` so tools / routes / future code read
*      a single source of truth (never call `scope.get()` ad-hoc — cache it).
*   4. Snapshot the LlmRuntime reference for tool bridges.
*   5. Wire settings.watch → ctx.effect so HMR / live edits are picked up.
*
* Tool + route registration land in Day 2 / Day 3; this skeleton is the
* minimum that proves settings + llm injection end-to-end.
*/
function apply(ctx, config) {
	ctx.inject(["settings", "llm"], (sctx) => {
		const scope = sctx.settings.register(NS, MediaStudioSettings);
		ctx.mediaStudio = {
			scope,
			getSettings: () => readMediaStudio(scope),
			llm: sctx.llm,
			workspaceRoot: config.workspaceRoot
		};
		bindMediaStudioContext(ctx);
		ctx.effect(() => {
			return scope.watch((next, prev) => {
				ctx.logger?.info?.(`[media-studio] settings changed: textModel ${prev.textModel} → ${next.textModel}`);
			});
		}, "media-studio: settings watcher");
		ctx.logger?.info?.(`[media-studio] ready: workspaceRoot=${config.workspaceRoot}, defaultCanvas=${config.defaultCanvasId}, textModel="${ctx.mediaStudio.getSettings().textModel || "(auto)"}"`);
		registerGenerateTextTool(ctx);
		registerGenerateImageTool(ctx);
		registerGenerateVideoTool(ctx);
		registerGenerateMusicTool(ctx);
		ctx.logger?.info?.("[media-studio] registered generate_text + generate_image + generate_video + generate_music tools");
	});
}
//#endregion
export { Config, DEFAULT_MEDIA_STUDIO, apply, inject, name };

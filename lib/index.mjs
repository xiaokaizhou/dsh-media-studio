import { MessageId } from "@deepseek-ai/dsh-llm";
import Schema from "@deepseek-ai/schemastery";
import { settingsNamespace } from "@deepseek-ai/dsh-settings";
import { defineTool } from "@deepseek-ai/dsh-tools";
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
//#region src/tools.ts
/**
* The `generate_text` tool. Sends a single prompt to the LLM the user has
* already configured in DSH (no provider list baked into this plugin). If
* the caller does not pass `model`, the user's `mediaStudio.textModel`
* setting is used; if that is blank too, the runtime's default model is
* left to the harness's own fallback path.
*
* Why one tool, not one per provider?
*   The whole point of the DSH plugin contract is that the harness owns
*   provider/model routing. Exposing `generate_text_anthropic` etc.
*   would silently duplicate that logic and break the moment the user
*   switches their default. One tool = one source of truth.
*
* Output shape (canonical JSON):
*   { text, model, usage: {inputTokens,outputTokens}, latencyMs }
*   `output.render` wraps the JSON in a human-readable prose card so the
*   chat surface shows the answer even when no UI card adapter is loaded.
*/
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
			llm: sctx.llm
		};
		ctx.effect(() => {
			return scope.watch((next, prev) => {
				ctx.logger?.info?.(`[media-studio] settings changed: textModel ${prev.textModel} → ${next.textModel}`);
			});
		}, "media-studio: settings watcher");
		ctx.logger?.info?.(`[media-studio] ready: workspaceRoot=${config.workspaceRoot}, defaultCanvas=${config.defaultCanvasId}, textModel="${ctx.mediaStudio.getSettings().textModel || "(auto)"}"`);
		registerGenerateTextTool(ctx);
		ctx.logger?.info?.("[media-studio] registered generate_text tool");
	});
}
//#endregion
export { Config, DEFAULT_MEDIA_STUDIO, apply, inject, name };

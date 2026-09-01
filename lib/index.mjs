import "@deepseek-ai/dsh-llm";
import Schema from "@deepseek-ai/schemastery";
import { settingsNamespace } from "@deepseek-ai/dsh-settings";
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
	});
}
//#endregion
export { Config, DEFAULT_MEDIA_STUDIO, apply, inject, name };

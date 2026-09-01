import "@deepseek-ai/dsh-llm";
import Schema from "@deepseek-ai/schemastery";
import { SettingsScope } from "@deepseek-ai/dsh-settings";
import { Context } from "@deepseek-ai/cordis";
//#region src/canvas-store.d.ts
/**
 * Canvas state management — server-side source of truth for the canvas tab.
 *
 * Modeled directly on the workflow-one `engine.js` Canvas 4-guard pattern:
 *   1. `no-graph`              — incoming payload has no nodes[] array
 *   2. `stale-version`         — incoming version < current version (someone else wrote newer)
 *   3. `empty-regression`     — incoming is empty while current isn't (don't blank the canvas)
 *   4. closed fiber cleanup   — disposed when the plugin unloads
 *
 * Persistence: every accepted write is atomically JSON-flushed to disk
 * (`workspaceRoot/canvases/<canvasId>.json`). The canvas store is
 * recovered from disk on plugin boot so closing/reopening DSH restores
 * the canvas exactly.
 */
interface CanvasNode {
  id: string;
  type: 'text' | 'image' | 'video' | 'music' | 'note';
  /** User-friendly label rendered in the canvas card. */
  label: string;
  /** Free-form data attached by the agent / UI: prompt, resultUrl, status, etc. */
  data: Record<string, unknown>;
  /** Logical position in the canvas; UI maps to x/y in px. */
  position?: {
    x: number;
    y: number;
  };
}
interface CanvasEdge {
  id: string;
  source: string;
  target: string;
  /** Optional branch label for condition nodes (true / false). */
  branch?: 'true' | 'false';
}
interface CanvasGraph {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
}
interface CanvasState {
  graph: CanvasGraph;
  /** Monotonic version, increments on every accepted patch. */
  version: number;
  /** Session ids currently bound to this canvas (for SSE scoping). */
  boundSessions: Set<string>;
}
interface CanvasSnapshot {
  graph: CanvasGraph;
  version: number;
}
interface PatchResult {
  /** The new graph after the patch was applied. */
  graph: CanvasGraph;
  /** Echo back the ops that were accepted (for the SSE listener). */
  patch: CanvasOp[];
  /** Canvas version after this patch (the SSE listener uses this to dedup). */
  version: number;
  /** Whether the post-patch lint passed (no errors, only warnings). */
  lintOk: boolean;
  /** Lint issues (warnings + errors). */
  issues: string[];
}
/**
 * The op union — extends dsh-harness-one's set with our own op codes.
 * See `validateOps` for the full grammar.
 */
type CanvasOp = {
  op: 'addNode';
  type: CanvasNode['type'];
  label: string;
  data?: Record<string, unknown>;
  position?: {
    x: number;
    y: number;
  };
} | {
  op: 'updateNode';
  id: string;
  data: Record<string, unknown>;
} | {
  op: 'renameNode';
  id: string;
  label: string;
} | {
  op: 'deleteNode';
  id: string;
} | {
  op: 'moveNode';
  id: string;
  position: {
    x: number;
    y: number;
  };
} | {
  op: 'connect';
  from: string;
  to: string;
  branch?: 'true' | 'false';
} | {
  op: 'deleteEdge';
  id: string;
} | {
  op: 'batchAddMedia';
  items: Array<{
    kind: 'image' | 'video' | 'audio';
    url: string;
    prompt?: string;
    model?: string;
    /** Position hint for the new node (UI may snap-to-grid). */
    position?: {
      x: number;
      y: number;
    };
    /** Optional explicit id; if absent we generate one. */
    nodeId?: string;
  }>;
};
declare class CanvasStore {
  private canvases;
  private workspaceRoot;
  constructor(workspaceRoot: string);
  /** Resolve one canvas (lazily created if absent). Key includes the workspace
   *  root so two profiles pointing at the same canvasId never collide. */
  canvasOf(canvasId: string): CanvasState;
  /**
   * Apply a batch of ops atomically. Either every op succeeds or the canvas
   * is left untouched and the caller gets a lint error back to fix and retry.
   */
  apply(canvasId: string, ops: CanvasOp[]): PatchResult;
  /** Read the snapshot the canvas tab needs to render. */
  snapshot(canvasId: string): CanvasSnapshot;
  /** Bind a session id to this canvas (for SSE scoping). */
  bindSession(canvasId: string, sessionId: string): void;
  unbindSession(canvasId: string, sessionId: string): void;
  boundSessions(canvasId: string): readonly string[];
  /** Restore every persisted canvas from disk into the in-memory map. */
  restore(): Promise<void>;
  private persist;
}
//#endregion
//#region src/settings.d.ts
interface MediaProvider {
  provider: string;
  baseURL: string;
  apiKey: string;
  defaultModel: string;
}
interface MediaMusicProvider extends MediaProvider {
  voice: string;
}
interface MediaStudioSettingsShape {
  textModel: string;
  image: MediaProvider;
  video: MediaProvider;
  music: MediaMusicProvider;
}
type MediaStudioScope = SettingsScope<MediaStudioSettingsShape>;
/** Default values when no user section is on disk. Keep in sync with the
 *  `.default(...)` calls above — `.get()` returns these when the section
 *  is empty, so anything reading the shape synchronously without going
 *  through the harness sees the same defaults. */
declare const DEFAULT_MEDIA_STUDIO: MediaStudioSettingsShape;
//#endregion
//#region src/config.d.ts
/**
 * Plugin-level config (the cordis.yml row). Holds ONLY values that
 * cannot live in the user-facing settings UI — typically filesystem
 * paths and boolean toggles a host admin owns. Everything user-tunable
 * (provider baseURL, API keys, model choice, voice) lives in the
 * `mediaStudio` settings namespace registered in `settings.ts` and is
 * surfaced to the DSH Settings page like any other plugin.
 *
 * Misconfiguration fails loud at load time (Schemastery), and every
 * field below is overrideable in cordis.yml without editing code.
 */
interface Config {
  /** Where canvas snapshots, generated media, and SSE journal land. */
  workspaceRoot: string;
  /** Canvas every freshly opened session is bound to by default. */
  defaultCanvasId: string;
  /** Send `MediaStudio/tool-call` events to the session log (replayable). */
  logToolCalls: boolean;
}
declare const Config: Schema<Config>;
//#endregion
//#region src/index.d.ts
declare const name = "dsh-media-studio";
/**
 * `settings` — register + watch the user-facing mediaStudio namespace.
 * `llm` — read the harness-native LlmRuntime so text tools can use whatever
 *         provider the user already configured in `~/.dsh/settings.yaml`.
 * `tools` — register our canvas + media generation tools.
 * `webServer` — register the SSE / HTTP routes the canvas tab subscribes to.
 */
declare const inject: string[];
declare module '@deepseek-ai/cordis' {
  interface Context {
    mediaStudio: {
      scope: MediaStudioScope;
      getSettings(): MediaStudioSettingsShape;
      /**
       * Reference to the harness-native LlmRuntime, captured at apply().
       * Plugins read this instead of `ctx.llm` to keep the surface explicit
       * and to let stub-friendly tests pass `undefined`.
       */
      llm: unknown;
      /** Resolved absolute workspace directory (cordis config wins over env). */
      workspaceRoot: string;
      /** Server-side canvas state (Day 4). Tools read / write through this. */
      canvasStore: CanvasStore;
      /** SSE client registry (Day 4) — the canvas tab subscribes here. */
      sseClients: Set<import('node:http').ServerResponse>;
    };
  }
}
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
declare function apply(ctx: Context, config: Config): void;
//#endregion
export { Config, DEFAULT_MEDIA_STUDIO, apply, inject, name };
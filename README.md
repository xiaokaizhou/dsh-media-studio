# dsh-media-studio

[![中文](https://img.shields.io/badge/语言-中文-blue)](./README.zh.md) [![English](https://img.shields.io/badge/language-English-lightgrey)](./README.md) [![npm](https://img.shields.io/npm/v/dsh-media-studio)](https://www.npmjs.com/package/dsh-media-studio)

A DeepSeek Harness (DSH) plugin that gives agents a **multi-project infinite-canvas editor**: canvas storyboards, a categorized asset library per project, global real-time asset search, and soft references across projects. Agent media generation (`generate_image` / `generate_video` / `generate_music` / TTS / `generate_vision`) lives in the sibling `dsh-llm-multimodal` plugin and is reached from here through the canvas "refresh" flows.

## Preview

![Media Studio canvas](https://raw.githubusercontent.com/xiaokaizhou/dsh-media-studio/main/.github/demo-canvas.png)

<sub>A 59-node AI micro-film board: five regions — planning, script, asset anchors, storyboard/keyframes, video clips — wired by 76 edges, viewed at 22% zoom. Click to enlarge.</sub>

## Built for AI video production

The canvas is the production board for long-form, multi-shot AI video work — the kind that needs consistent characters, persistent assets, and a shot-by-shot topology rather than a single prompt:

| Use case | What the canvas gives you |
|---|---|
| **AI comic drama (AI 漫剧)** | One region per episode: character/scene asset blocks stay reusable across shots, and a shared art-style node feeds every downstream prompt so the look holds together across dozens of panels |
| **AI micro film (AI 微电影)** | Script → storyboard → shot → edit regions make the whole film auditable at a glance; first/last-frame keyframe chaining keeps consecutive shots continuous instead of looking like slides |
| **AI video creation (AI 视频创作)** | Any multi-shot piece — product ads, MV, explainers. Node-level `canvas_refresh_node` re-generates just the shot that missed, without redoing the rest of the board |

The features below are what make that practical: a per-project **asset library** (characters / scenes / audio / clips) keeps a protagonist visually consistent, **soft references** let one character asset serve many canvases without copying files, and **global search (⌘K)** finds a scene asset from an older project to reuse in the current one.

## Companion plugins

This plugin forms a complete **generate → orchestrate → preview** loop with two sibling DSH plugins by the same author. Install them together:

| Plugin | Role | npm |
|---|---|---|
| [dsh-llm-multimodal](https://github.com/xiaokaizhou/dsh-llm-multimodal) | The generation backend: `generate_image` / `generate_video` / `generate_vision` / `generate_tts` / `generate_music` / `generate_text`, auto-discovered from `llm-pi-ai` | [npm: dsh-llm-multimodal](https://www.npmjs.com/package/dsh-llm-multimodal) |
| [media-preview](https://github.com/xiaokaizhou/dsh-media-preview) | Renders local/online media paths in chat as playable previews (Range / caching / 27 formats) | [npm: media-preview](https://www.npmjs.com/package/media-preview) |

- **Generate → orchestrate**: this plugin publishes the cross-plugin `mediaStudio` service (`ctx.reflect.provide`, soft reference — no hard dependency on either side). `dsh-llm-multimodal` reads it via `ctx.get('mediaStudio')` and writes generated media straight into the active project's `<sourcePath>/assets/<kind>/` instead of `/tmp`; results carry `projectId` + `canvasUrl` that `batchAddMedia` attaches to canvas nodes. When this plugin is absent, the generator falls back to its own `outputDir` strategy — install order does not matter.
- **Orchestrate → preview**: media files written under a project are served through `/api/media-studio/media-file`, while `media-preview` renders `file://` paths inline in chat.

## Compatibility

| Surface | Status |
|---|---|
| Harness | DeepSeek Harness `0.1.1-rc.2` |
| Node | `^22.19.0 || >=24.0.0` |
| Platforms | All (plain ESM; no native code, no network) |

## What it does

- **Infinite canvas** (Media Studio sidebar tab, via `betterSidebar`). Server-authoritative state + SSE live updates; keyboard/mouse editing, undo/redo, minimap, auto-arrange, media preview/lightbox.
- **Agent tools (25)**: 13 `canvas_*` (graph view/patch, auto-arrange, node refresh, single-node CRUD, region CRUD/fit) + 12 `media_studio_*` (project management, asset library, global search). Blank `canvasId` resolves to the **active project**'s canvas.
- **Regions**: named container boxes that partition the canvas into blocks (overview / script / characters / scenes / storyboard / media). Nodes belong via `data.region`; boxes auto-grow as nodes are added and can be dragged, locked, and fitted to their contents. `canvas_auto_arrange({ regionId })` re-arranges only that region.
- **Projects (M0/M1)**: `projects.json` registry + per-project `assets/`; every legacy canvas is auto-promoted to a project on first boot. Top bar "项目" menu: new / open / recent (≤10) / rename / delete with dependency analysis; deletion goes to `<ws>/trash/` by default. Projects created with a `sourcePath` keep their canvas and assets in the user's own directory.
- **Asset library (M2)**: four categories (characters / scenes / audio / clips). Save any canvas media card into the library; browse/rename/copy-to-project/delete-with-preflight in the asset panel. Asset file names are asset ids — renames never break references.
- **Global search + soft references (M3)**: top-bar live search (⌘K) fuzzy-matches library assets and finished canvas media across **all** projects, grouped into current-project / other-projects. "+ 添加" soft-references a library asset into the active canvas (`data.assetRef` — no file copied); canvas-media results get "复制入库". References are tracked for deletion preflights; on source deletion you may migrate referenced assets into the shared library (`__shared`) or break-and-mark the referencing nodes.
- **zh/en UI**: minimal i18n; follows the DSH Language setting (`ctx.locale`).

Everything is REST + SSE under `/api/media-studio/*`: `projects*` (list/create/open/rename/delete/dependents/open-folder/pick-folder/reveal), `assets*` (list/register/update/delete/copy/dependents/sync-file), `refs`, `search`, `search/import-canvas`, `canvas/*` (state/patch/auto-arrange/refresh/backfill-video-posters), `media-file` proxy, `service-worker.js`, and the unified `sse` endpoint.

> **One SSE connection only.** Canvas patches and registry changes (`registry-changed` / `project-open` / `project-deleted` / `asset-changed` / `project-focused`) are multiplexed over a single `/api/media-studio/sse` stream. This is deliberate: HTTP/1.1 caps a host at 6 connections, and DSH core already holds several. The connection is paused while the tab is hidden and syncs a fresh snapshot after reconnect. Adding a second EventSource is a regression — merge into this endpoint instead.

## Install

```sh
# Option 1 (recommended): dsh CLI from the npm registry
dsh plugin --profile web add dsh-media-studio

# Option 2: from a packed tarball
pnpm pack
dsh plugin --profile <name> add ./dsh-media-studio-0.3.1.tgz

# verify the row mounted
dsh --profile <name> --dump-config | grep 'dsh-media-studio'
```

### Optional: the media-studio agent preset

The package also ships an agent preset (`src/presets/media-studio/agent.cordis.yml`) that gives a session a media-production persona and the matching prompt sections. Tools are **not** declared there — the plugin's own fiber already registers them, and every session inherits them through `ctx.tools`. The preset only adds identity and prompt framing.

From a source checkout, `pnpm run prepare` (or `bash scripts/setup-preset.sh [profile]`) symlinks it into `$DSH_HOME/profiles/<profile>/agent-presets/media-studio/`. From an npm install, symlink it yourself from `node_modules/dsh-media-studio/src/presets/media-studio/agent.cordis.yml`. Then pick **media-studio** in the agent preset selector, or run `/preset media-studio` in chat. Skipping this step entirely is fine — the canvas tab and all 25 tools work without it.

## Configuration

| Key | Type | Default | Description |
|---|---|---|---|
| `workspaceRoot` | string | `~/.media-studio` | Registry, legacy canvases, trash |
| `mediaRoots` | string[] | `['~/Movies']` | Extra roots the media-file proxy may serve. Defaults to `~/Movies` so drama/film projects created with a `sourcePath` under it render out of the box. Leading `~` is expanded |
| `defaultCanvasId` | string | `main` | Fallback canvas id (active project wins) |
| `logToolCalls` | boolean | `true` | Append tool results to the session log |
| `recentLimit` | number | `10` | Max "recently opened" projects kept (1–50) |
| `trashEnabled` | boolean | `true` | Deletions move to `<ws>/trash` unless permanent |

Validated by the Schemastery `Config` schema in `src/config.ts`; no tunable is hardcoded. A running profile can override any of these through its `cordis.patch.yml`.

## Development

```sh
pnpm install
pnpm run typecheck        # server sources
pnpm run typecheck:client # browser sources (tsc)
pnpm test                 # vitest (store, project, asset, search, perf suites)
pnpm run build            # tsdown → lib/
pnpm pack
```

### Performance contracts

Several hot paths are pinned by regression tests, because a 100 ms vs 1 s difference is invisible in review but obvious in CI:

| Contract | Test |
|---|---|
| Persist is debounced — 100 sync `apply` calls → ≤2 writes | `tests/persistence-debounce.test.ts` |
| `postProcessCanvasPatch` batches N video nodes into a single `apply` | `tests/post-process-batching.test.ts` |
| 1000 sync `apply` calls finish <500 ms with ≤2 writes | `tests/perf-budget.test.ts` |
| Media file names are stable (sha1-derived, 16-hex) | `tests/stable-filename.test.ts` |
| `gcOrphanMedia` deletes only unreachable `v-` / `a-` / `i-` files | `tests/orphan-gc.test.ts` |
| SSE broadcasts are bucketed per `canvasId` | `tests/sse-bucketing.test.ts` |
| Merge token short-circuits on unchanged node data | `tests/canvas-rerender-discipline.test.ts` |
| `loadAssetIndex` hits its mtime cache (`Object.is` stable) | `tests/search-cache.test.ts` |
| `openProject` restores only the target canvas | `tests/restore-target.test.ts` |
| `dependentsOf` / `scanAssetRefs` never deep-copy the canvas | `tests/dependents-no-clone.test.ts` |

Any change to a hot path (writes, SSE, media processing, dependency scans, canvas rendering) must ship with a matching regression test.

## Sponsorship

If this plugin saves you time, you can buy me a coffee with one of the following QR codes.

<table>
  <tr>
    <td align="center">
      <img src="https://raw.githubusercontent.com/xiaokaizhou/dsh-media-studio/main/.github/wechat-pay.jpg" width="180" alt="WeChat Pay"><br>
      <strong>WeChat Pay</strong>
    </td>
    <td align="center">
      <img src="https://raw.githubusercontent.com/xiaokaizhou/dsh-media-studio/main/.github/alipay.jpg" width="180" alt="Alipay"><br>
      <strong>Alipay</strong>
    </td>
  </tr>
</table>

## License

[Apache License 2.0](LICENSE) © 2026 dsh-media-studio contributors.

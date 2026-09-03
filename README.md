# dsh-media-studio

A DeepSeek Harness (DSH) plugin that gives agents a **multi-project infinite-canvas editor**: canvas storyboards, a categorized asset library per project, global real-time asset search, and soft references across projects. Agent media generation (`generate_image` / `generate_video` / `generate_music` / TTS) lives in the sibling `dsh-llm-multimodal` plugin and is reached from here through the canvas "refresh" flows.

## Compatibility

| Surface | Status |
|---|---|
| Harness | DeepSeek Harness `0.1.1-rc.2` |
| Node | `^22.19.0 || >=24.0.0` |
| Platforms | All (plain ESM; no native code, no network) |

## What it does

- **Infinite canvas** (Media Studio sidebar tab, via `betterSidebar`). Server-authoritative state + SSE live updates; keyboard/mouse editing, undo/redo, minimap, auto-arrange, media preview/lightbox.
- **Agent tools** (canvas-only): `canvas_graph_view`, `canvas_graph_patch` (atomic batched ops incl. `batchAddMedia`), `canvas_auto_arrange`, `canvas_refresh_node`. Blank `canvasId` resolves to the **active project**'s canvas.
- **Projects (M0/M1)**: `projects.json` registry + `<ws>/projects/<id>/assets/`; every legacy canvas is auto-promoted to a project on first boot. Top bar "项目" menu: new / open / recent (≤10) / rename / delete with dependency analysis; deletion goes to `<ws>/trash/` by default.
- **Asset library (M2)**: four categories (人物资产 characters / 场景资产 scenes / 音频资产 audio / 视频片段 clips). Save any canvas media card into the library; browse/rename/copy-to-project/delete-with-preflight in the asset panel. Asset file names are asset ids — renames never break references.
- **Global search + soft references (M3)**: top-bar live search (⌘K) fuzzy-matches library assets and finished canvas media across **all** projects, grouped into current-project / other-projects. "+ 添加" soft-references a library asset into the active canvas (`data.assetRef` — no file copied); canvas-media results get "复制入库". References are tracked for deletion preflights; on source deletion you may migrate referenced assets into the shared library (`__shared`) or break-and-mark the referencing nodes.
- **zh/en UI**: minimal i18n; toggle in the Project menu (browser language default).

Everything is REST + SSE under `/api/media-studio/*` (`projects*`, `assets*`, `refs`, `search`, `canvas/*`, `media-file` proxy, `projects/sse`).

## Install

```sh
pnpm pack
dsh plugin --profile <name> add ./dsh-media-studio-0.3.0.tgz
dsh --profile <name> --dump-config | grep 'dsh-media-studio'
```

## Configuration

| Key | Type | Default | Description |
|---|---|---|---|
| `workspaceRoot` | string | `~/.media-studio` | Registry, canvases, per-project asset folders, trash |
| `mediaRoots` | string[] | `[]` | Extra roots the media-file proxy may serve |
| `defaultCanvasId` | string | `main` | Fallback canvas id (active project wins) |
| `logToolCalls` | boolean | `true` | Append tool results to the session log |
| `recentLimit` | number | `10` | Max "recently opened" projects kept |
| `trashEnabled` | boolean | `true` | Deletions move to `<ws>/trash` unless permanent |

Validated by the Schemastery `Config` schema in `src/config.ts`; no tunable is hardcoded.

## Development

```sh
pnpm install
pnpm run typecheck        # server sources
pnpm run typecheck:client # browser sources (tsc)
pnpm test                 # vitest (store, project, asset, search suites)
pnpm run build            # tsdown → lib/
pnpm pack
```

## License

[Apache License 2.0](LICENSE) © 2026 dsh-media-studio contributors.

# dsh-media-studio — Agent Usage Guide

## Overview

`dsh-media-studio` 是一个 DeepSeek Harness 插件，为 agent 提供**多项目无限画布 + 素材库 + 全局素材搜索/软引用**：

- 每个**项目**拥有 1 个主画布与一套分门别类的素材库（人物 / 场景 / 音频 / 视频片段）。
- Agent 通过 `canvas_graph_patch` 等画布工具编排管线；生成能力（`generate_text` / `generate_image` / `generate_video` / `generate_music`/TTS）位于姊妹插件 `dsh-llm-multimodal`，`canvas_refresh_node` 会经由 `ctx.tools.execute` 调用它们。
- 用户可在 DSH Web GUI 的 Media Studio 标签页实时查看/操作（顶部「项目」菜单 + 素材库面板 + 顶栏全局搜索）。

**画布为服务端权威**：每次接受写入都持久化并 SSE 广播；Agent 工具与浏览器 UI 走同一条 `CanvasStore.apply` 通道，因此双方永远看到一致状态。

## 已注册工具

| 工具名 | 作用 |
|---|---|
| `canvas_graph_view` | 读取画布快照（nodes + edges + version） |
| `canvas_graph_patch` | **原子批量写画布**（单批 ≤60 op） |
| `canvas_auto_arrange` | 按边深度自动整理布局 |
| `canvas_refresh_node` | 基于上游内容重新生成某媒体节点（代理到 dsh-llm-multimodal） |

> 缺省 `canvasId` = **当前激活项目**的画布（注册表 `activeId`；无项目时回退 `main`）。显式传 `canvasId` 仍然有效。

## 典型工作流

1. （可选）`canvas_graph_view` 确认画布/版本，避免基于过期状态决策。
2. 生成媒体（走 dsh-llm-multimodal 的 `generate_image/video/music`）→ 拿到本地文件路径/URL。
3. **单次** `canvas_graph_patch` 完成建节点/连线/落媒体（`batchAddMedia`），避免多次往返部分丢失。
4. 想让某张卡长期复用？用户可在卡上「存入素材库」（复制文件进项目素材库并登记）；Agent 也可引导用户用顶栏搜索把其他项目的素材**软引用**进当前画布。

## 数据与语义（关键契约）

- 项目 id 稳定不可变（`p-…` 或迁移期沿用旧 canvas id）；**重命名只改显示名**，不动任何路径/引用。
- 素材文件名 = `<assetId>.<ext>`，与显示名解耦 → 改名永不断引用。
- **软引用** = 画布节点 `data.assetRef: { projectId, assetId }` + `resultUrl` 指向源项目素材文件（不复制文件）。已在节点上的标记：
  - `assetRef` 引用元数据（projectId/assetId）
  - `brokenAsset: true` + `status:'error'` = 源已删除/断链占位
  - `refCopiesFrom`（旧/画布级）与素材索引内 `copyOf`（M2 硬复制）用于“副本消费方”统计
- **删除安全网**：删除项目/资产前服务端做依赖预检；默认**拦截**。可选三种处理：
  - `migrate-shared`：把被引用资产迁入共享库 `__shared`（引用改写仍有效）
  - `break-refs`：删除并把所有引用节点标记 `brokenAsset`
  - `cancel`（默认）：什么都不做并报 `project-referenced` / `AssetDeleteBlockedError`
- 删除默认进 `<ws>/trash/`（可恢复）；`permanent` 才硬删。

## 搜索语义

`GET /api/media-studio/search?q=…&scope=<projectId>` 对**全部项目**做模糊匹配（名称 > 标签 > prompt），结果分两组：当前项目 / 其他项目。语料 = 各项目素材库登记资产 + 画布上已完成媒体节点（后者标注“画布素材”、排序靠后、已被登记的节点去重）。`alreadyRefCount` = 作用域项目对该素材已有的软引用数。

## 节点类型

| type | 说明 | 典型 data 字段 |
|---|---|---|
| `text` | 文本/脚本 | `{ text, model? }` |
| `image` | 图片 | `{ prompt, model, resultUrl, status }` |
| `video` | 视频 | `{ prompt, model, resultUrl, status }` |
| `music` | 音频/TTS | `{ text, voice, resultUrl, status }` |
| `note` | 备注 | `{ content }` |

## 画布 Tab

- 路径：DSH Web GUI → 侧栏 `+ 新建标签页` → `Media Studio`（betterSidebar 注册，id `media-studio:canvas`）。
- 顶部条：**[项目 ▾]**（新建 / 打开 / 最近打开≤10 / 当前项目行可改名·删除 / 素材库 / 语言切换）+ **全局搜索框**（⌘K，实时分组结果，“+ 添加”=软引用到当前画布，“复制入库”=画布素材硬复制进当前项目素材库）+ 当前项目名。
- 素材库面板（▤ 入口）：4 类网格浏览、行内改名、跨项目复制、删除预检、画布来源资产“从画布同步”。
- 媒体卡 hover 工具条新增「存入素材库」（复制进项目素材库，按画布节点幂等去重）。
- 每个项目记住视口位置（localStorage），切换回来恢复镜头。
- SSE wire shape（关键：必须带 `event:` 行，否则命名监听收不到）：
  ```
  event: canvas-patch
  data: {"type":"canvas-patch","canvasId":"…","version":N,"graph":{…},"patch":[…]}
  ```
  项目级事件独立流 `/api/media-studio/projects/sse`（`registry-changed` / `project-open` / `project-deleted` / `asset-changed`），同样带 `event:` 行。

## 持久化布局（workspaceRoot）

```
<ws>/projects.json                  # 项目注册表（activeId / recent≤recentLimit / 项目元数据）
<ws>/projects/<id>/assets/{characters,scenes,audio,clips}/ + index.json   # 素材
<ws>/shared-assets/                 # __shared 共享库（被引用资产迁居地）
<ws>/canvases/<id>.json             # 画布（id = 项目 id；旧画布原样保留）
<ws>/trash/                         # 回收站（默认软删除）
<ws>/web-jobs/                      # 生成媒体落点（dsh-llm-multimodal 写入）
```
> 运行 profile 会以 cordis.patch.yml 覆盖 `workspaceRoot`（web profile 为 `/tmp/canvas-smoke`）——查持久化/媒体代理以运行 profile 为准。首次升级启动会把旧 `canvases/*.json` 自动提升为项目（legacy 标记）。

## 错误处理

- 生成工具返回 `{ ok: true, ... }` 或 `{ ok: false, code, message }`，不依赖 throw。常见 code：`missing-baseurl`、`http-401`、`video-timeout`、`not-supported`。
- `canvas_graph_patch` 被拒（lint/原子性）会 throw 一条含原因的消息 → 先 `canvas_graph_view` 再重试。画布版本冲突由 4-guard 处理。
- 删除被引用项目/资产 → 409/`AssetDeleteBlockedError`，消息里带 `dependents`/`hits` 明细；选择级联模式后重试。

## 配置

- 插件级（bundle 行，Schemastery）：`workspaceRoot`、`mediaRoots`、`defaultCanvasId`、`logToolCalls`、`recentLimit`(10)、`trashEnabled`(true)。
- 媒体提供商配置在 **dsh-llm-multimodal** 的 `llm-multimodal` settings 命名空间（DSH Settings UI），与本插件无关。

## 开发

```sh
pnpm run typecheck          # 服务端 tsc
pnpm run typecheck:client   # 浏览器源 tsc
pnpm test                   # vitest：canvas-store / project-store / asset-store / search
pnpm run build              # tsdown → lib/
pnpm pack
```
重启验证：`lsof -tiTCP:<port> | xargs kill` 后重启 `dsh web`，用 curl 冒烟 `/api/media-studio/projects`、`/api/media-studio/search?q=…`、`/api/media-studio/canvas/state`。

## 最佳实践

1. **先 view 再 patch**；一次 patch 完成批量操作。
2. 处理视频超时（30–90s）勿过早判定失败；`video-timeout` 视为可重试。
3. 管线迭代中 `deleteNode` 清理旧结果。
4. 新建项目由用户在「项目 → 新建」创建（或未来 agent 工具）；Agent 操作画布默认落在当前激活项目，勿假设固定 canvasId。
5. 素材登记/软引用是用户交互能力；如需为素材建库，引导用户把卡片「存入素材库」，再用顶栏搜索跨项目复用。
6. 修改服务端后跑全套 `pnpm test`；客户端改动需跑 `typecheck:client`；行为改动重启后在浏览器/curl 复测。

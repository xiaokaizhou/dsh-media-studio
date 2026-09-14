# dsh-media-studio — Agent Usage Guide

## Overview

`dsh-media-studio` 是一个 DeepSeek Harness 插件，为 agent 提供**多项目无限画布 + 素材库 + 全局素材搜索/软引用**：

- 每个**项目**拥有 1 个主画布与一套分门别类的素材库（人物 / 场景 / 音频 / 视频片段）。
- Agent 通过 `canvas_graph_patch` 等画布工具编排管线；生成能力（`generate_text` / `generate_image` / `generate_video` / `generate_music`/TTS）位于姊妹插件 `dsh-llm-multimodal`，`canvas_refresh_node` 会经由 `ctx.tools.execute` 调用它们。
- 用户可在 DSH Web GUI 的 Media Studio 标签页实时查看/操作（顶部「项目」菜单 + 素材库面板 + 顶栏全局搜索）。

**画布为服务端权威**：每次接受写入都持久化并 SSE 广播；Agent 工具与浏览器 UI 走同一条 `CanvasStore.apply` 通道，因此双方永远看到一致状态。

## 画布协作原则（LLM 自约束 / Built-in Workflow Rules）

为了让**发布后的用户**在不改自己 agent preset 的情况下也能让 LLM 遵守画布协作纪律，本插件把 5 条规则写进所有 `media_studio_*` 与 `canvas_*` 工具的 `description`（definition 的 `name`+`description` 自动汇入 system-prompt；详见 DSH `subsystems/system-prompt.md` 的 `ToolProviderResult.schemas`）。这是**唯一能在部署侧不修改 preset 就生效的引导机制** —— preset 是 deployment-scoped，插件无法为用户写入。

| # | 原则 | 落点（description 中） |
|---|---|---|
| 1 | 创建新项目 → 先调 `media_studio_create_project`；SSE `project-focused` 事件触发客户端 `betterSidebar.activateTab('media-studio:canvas')` | `media_studio_create_project` |
| 2 | 画布操作 → 客户端 `SidebarFocusListener` 监听 SSE 自动激活 Media Studio 侧 tab | `canvas_*` 全部 |
| 3 | 内容产出 → 必须落到 canvas 节点（`batchAddMedia` + `canvas_node_update`） | `canvas_*` + `media_studio_*` |
| 4 | 不留空节点 → 创建 `text`/`note` 后必须紧跟 `canvas_node_update` 补内容；`image`/`video`/`music` 用 `canvas_refresh_node` 填 resultUrl | `canvas_node_add` / `canvas_node_update` / `canvas_refresh_node` |
| 5 | 不留孤儿节点 → 非种子节点的 `addNode` 必须同批带 `connect(prev, new)` | `canvas_graph_patch` + `canvas_node_add` |

> **机制边界**：DSH 的 `betterSidebar` 是 client-side service（运行在浏览器），server-side agent 不能直接命令 GUI。"自动打开侧栏"必须走 `工具调用 → SSE 广播 → 客户端监听 → activateTab` 这条链。本插件已通过 `project-focused` SSE 事件 + `SidebarFocusListener` 组件实现。

> **未来扩展**：若希望某些用户能更细粒度地覆盖规则，可在自己 profile 的 `agent.cordis.yml` 的 `@deepseek-ai/dsh-system-prompt-section` 里再附加 section（preset 范围生效）。本插件不主动写入 preset。

## 已注册工具

### 画布（7 个）

| 工具名 | 作用 |
|---|---|
| `canvas_graph_view` | 读取画布快照（nodes + edges + **regions** + version） |
| `canvas_graph_patch` | **原子批量写画布**（单批 ≤60 op；支持 `addRegion/updateRegion/deleteRegion`、`addNode.regionId`、`connect.label`、`batchAddMedia.items[].regionId`） |
| `canvas_auto_arrange` | 按边深度自动整理布局；`regionId` 参数可只整理某个分区内的节点 |
| `canvas_refresh_node` | 基于上游内容重新生成某媒体节点（代理到 dsh-llm-multimodal） |
| `canvas_region_add` | 新建分区容器（`label` 必填，`kind/id/x/y/w/h` 可选；无坐标时自动堆叠在最低分区下方，默认 720×400） |
| `canvas_region_update` | 浅更新分区（label / kind / 几何） |
| `canvas_region_delete` | 删除分区**容器盒**（不级联删除其中的节点） |
| `canvas_region_fit` | 把分区盒**紧贴包裹**其成员节点（小内边距 + 顶部标题带）；空分区不动。新增节点带 `regionId` 时盒会**自动扩容**，此工具用于节点被手动拖出盒外后的收拢 |

### 单节点 CRUD（5 个）

| 工具名 | 作用 |
|---|---|
| `canvas_node_view` | 读单个节点（无副作用，比 view 快照便宜） |
| `canvas_node_add` | 新建一个节点（strict schema，自动定位 / 自动生成 id） |
| `canvas_node_update` | 浅合并 data 到现有节点（不删除 key） |
| `canvas_node_rename` | 只改 label，data 不动 |
| `canvas_node_delete` | 删除节点；与它相连的所有边自动清除 |

> 缺省 `canvasId` = **当前激活项目**的画布（注册表 `activeId`；无项目时回退 `main`）。显式传 `canvasId` 仍然有效。

### 项目管理（6 个）

| 工具名 | 作用 |
|---|---|
| `media_studio_list_projects` | 列出注册表（active / recent ≤ recentLimit / all）；只读 |
| `media_studio_create_project` | 新建项目（可选 `sourcePath` 把项目落在用户自有目录），自动激活 |
| `media_studio_pick_folder` | macOS 原生 NSOpenPanel 选目录，返回 POSIX 路径（与 `create_project` 的 `sourcePath` 配套） |
| `media_studio_open_project` | 激活已有项目（顶入 recent 并从磁盘恢复画布） |
| `media_studio_rename_project` | 重命名（id 不变；若有 `sourcePath` 同步重命名磁盘目录） |
| `media_studio_delete_project` | 删除（`mode=trash|permanent` × `cascade=cancel|break-refs|migrate-shared`）；被引用时返回 `code:"project-referenced" + dependents` |

### 素材库（5 个）

| 工具名 | 作用 |
|---|---|
| `media_studio_list_assets` | 列出某项目素材库（character / scene / audio / clip） |
| `media_studio_register_asset` | 把画布节点的媒体正式入库（按 canvasNodeId 幂等去重） |
| `media_studio_update_asset` | 改资产名 / 标签（≤12 个） |
| `media_studio_delete_asset` | 删除资产（同 `cascade` 三档）；被引用时返回 `dependents` |
| `media_studio_copy_asset` | 跨项目硬拷贝（产生新 assetId；引用请用 `search_assets + addSoftRef`） |

### 全局搜索（1 个）

| 工具名 | 作用 |
|---|---|
| `media_studio_search_assets` | 跨项目模糊匹配（catalog=`library`/`canvas`），结果分「当前 / 其他」两组；当 `addSoftRef=true` + `addAssetKey=<key>` 一步把素材软引用进当前画布 |

> **REST 仍然可用**：`/api/media-studio/{projects,assets,search}/*` 与上述工具 1:1 对应，GUI / curl / 脚本任意入口，状态永远一致。

## 典型工作流

1. （可选）`canvas_graph_view` 确认画布/版本，避免基于过期状态决策。
2. 生成媒体（走 dsh-llm-multimodal 的 `generate_image/video/music`）→ 拿到本地文件路径/URL。
3. **单次** `canvas_graph_patch` 完成建节点/连线/落媒体（`batchAddMedia`），避免多次往返部分丢失。
4. 想让某张卡长期复用？用户可在卡上「存入素材库」（复制文件进项目素材库并登记）；Agent 也可引导用户用顶栏搜索把其他项目的素材**软引用**进当前画布。

## 数据与语义（关键契约）

- 项目 id 稳定不可变（`p-…` 或迁移期沿用旧 canvas id）；**重命名 id 不变**。
- 项目的「重命名」语义：若项目有 `sourcePath`（即由原生选目录创建、目录归用户所有），同时把磁盘上 `sourcePath` 对应的目录名改成新名，并把新路径写回 `projects.json`；canvas 内的 `assetRef.projectId` / 节点 id 等不依赖目录名，因此引用不破。若没有 `sourcePath`（纯注册表项目 / legacy），只改 `name` 字段。
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

## 分区（Region）语义

分区是**纯容器**，用于把画布按业务区块划分（如：流程总览 / 剧本文案 / 人物资产 / 场景资产 / 分镜区 / 成片与音频），客户端以虚线盒 + 标题 pill 渲染，区内节点按宫格排列。

- 节点归属 = `data.region = <regionId>`（`addNode.regionId` / `batchAddMedia.items[].regionId` 自动写入；带 regionId 且不传 position 时，节点落在分区自己的 宫格网格 `regionSlot` 内，而不是全局 `defaultSlot`）。
- 分区几何：默认 720×400（容纳 2 列宫格），`REGION_HEADER_H=64` 顶部标题区留给标题；区内网格列距 300、行距 300（卡片 240px + 60px 间距）、内边距 24、容量上限 240。
- `canvas_region_delete` 只删盒不删节点（节点保留原位置，`data.region` 指向失效 id —— 需要时用 `updateNode` 清掉或补回）。
- `canvas_auto_arrange({ regionId })` 只重排该分区成员，列在分区宽度内折行、不出界；**不带** regionId 时仍是全画布按边深度布局。
- 边可带语义 `label`（如「角色清单来源」「一致性锚点」）。**画布 UI 不渲染边标签**（产品决定：视觉上只保留连线本体）；`label` 仍随 `connect` 写入图数据并参与版本令牌，供刷新协议 / 语义字典使用。
- 持久化：`canvases/<id>.json` 顶层新增 `regions` 数组，旧文件缺省视为空；`restore` / 级联迁移均带 regions。
- **自动扩容**：`addNode` / `batchAddMedia` 带 `regionId` 落宫格时，若新节点超出分区右/下沿，分区 `w/h` 就地扩大（宫格 240px 卡片 + 300px 列/行距，60px 间距），保证「节点永远在盒内」——agent 无需手工维护几何；节点被手动拖出后可用 `canvas_region_fit` 收拢。
- **autoArrange 自动收拢**：`canvas_auto_arrange`（含 `regionId` 单分区版）整理完节点位置后，会自动对受影响的分区执行 `fitRegion`，盒子紧贴内容（底部仅留 `REGION_PAD` 内边距，不设 HEADER 预留），不会留下大片空白。`fitRegion` 保证区域底部始终不低于内容最低点 + 内边距，因此即便节点被移到区域顶部附近，盒子也不会短到导致节点溢出。
- **客户端交互**（`ms-region-layer` 经 `ViewportPortal` 渲染进 viewport，随缩放平移）：标题栏提供「贴合内容」「删除分区」按钮；右下角手柄可拖拽调整大小（落盘一次 `updateRegion`，可撤销）。**整张分区可拖动**：分区盒的 `.ms-region` 容器本身是 `pointer-events:auto` + `nopan nodrag` 的拖拽面，从标题栏、标题带空白、或盒内任意空白处按下并拖动即可移动分区，分区内子节点跟随一起平移（点击按钮 / 重命名输入框 / 右下角调把手柄不会触发拖动，落点交给各自的事件流；因此盒顶那条标题带不会再「透传给画布平移」）。拖动期间 `data-region-dragging` 切换为 `true`，CSS 提供 grabbing 光标 + 加亮边框的 active 视觉反馈。**锁定图标**：`constrained=true` 时锁按钮带 `is-locked` 类，蓝色图标 + 浅蓝底片，一眼可辨已锁。**节点自动归属**：用户把节点视觉上拖进某个分区后，`onNodeDragStop` 会按节点中心点所在分区自动写入 `data.region`；拖出分区时用显式 `region: null` 清掉归属（`undefined` 会被 `JSON.stringify` 丢弃、到服务端不生效，故用 `null`，服务端 `updateNode` 见 `region===null` 即删除该键）。**重新加锁不回收外部节点**：`updateRegion` 刚把 `constrained` 从 false 翻成 true（`justLocked`）时，中心点已在盒外的成员**直接脱落归属**（留在原地、不再跟随分区拖拽），盒内成员照常夹回盒内；而已经是锁定态的分区做 resize/move 时仍按旧行为把溢出成员夹回盒内（`justLocked=false`）。分区锁定后，锁定的活动范围是**整个分区**（`[region.x, region.x + region.w - cardW] × [region.y, region.y + region.h - cardH]`），不再有 PAD 或 HEADER 预留内缩。

## 画布 Tab

- 路径：DSH Web GUI → 侧栏 `+ 新建标签页` → `Media Studio`（betterSidebar 注册，id `media-studio:canvas`）。
- 顶部条：**[项目 ▾]**（新建 / 打开本地文件夹 / 最近打开≤10 / 当前项目行可改名·删除 / 素材库）+ **全局搜索框**（⌘K，实时分组结果，“+ 添加”=软引用到当前画布，“复制入库”=画布素材硬复制进当前项目素材库）+ 当前项目名。语言切换跟随 DSH 设置 → Language（`ctx.locale`），不再自带语言按钮；重命名项目时若项目有 `sourcePath`（即在用户目录下）会同步重命名磁盘目录并更新 `~/.media-studio/projects.json`。
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

带 `sourcePath` 的项目（当前所有注册项目均有；`createProject` 默认给 `~/Movies/<名称>`）画布与素材都在用户自己的 sourcePath 下，workspaceRoot 只保留注册表：

```
<ws>/projects.json                  # 项目注册表（activeId / recent≤recentLimit / 项目元数据）
<ws>/shared-assets/                 # __shared 共享库（被引用资产迁居地）
<ws>/trash/                         # 回收站（默认软删除）

<sourcePath>/.canvas.json           # 画布（id = 项目 id）
<sourcePath>/assets/{characters,scenes,audio,clips}/ + .index.json   # 素材

<ws>/canvases/<id>.json             # 旧版画布（无 sourcePath 的 legacy 项目回退；首次启动自动提升为项目）
<ws>/projects/<id>/assets/… + index.json   # 旧版素材（legacy 回退）
<ws>/web-jobs/                      # 遗留：dsh-llm-multimodal 回退落点（服务缺失 / 无活跃项目 /
                                     #  outputStrategy=outputDir 时才写入；默认策略下通常不出现）
```
> 运行 profile 会以 cordis.patch.yml 覆盖 `workspaceRoot`（web profile 为 `/tmp/canvas-smoke`）——查持久化/媒体代理以运行 profile 为准。首次升级启动会把旧 `canvases/*.json` 自动提升为项目（legacy 标记）。
> 插件在 apply() 发布跨插件服务 `mediaStudio`（`ctx.reflect.provide`，`src/media-studio-service.ts`）：`getActiveProjectId()` / `getActiveProject()` / `resolveAssetDir(projectId?, kind?)` / `workspaceRoot()`。dsh-llm-multimodal 以 `ctx.get('mediaStudio')` 软引用，把生成媒体直写活跃项目的 `<sourcePath>/assets/<kind>/`（图片默认 character、视频 clip、音频 audio，generate_image 可用 `asset_kind` 指定 scene 等）；服务缺失或无活跃项目时回退 `outputDir`（空 → `/tmp`），无硬依赖。

## 错误处理

- 生成工具返回 `{ ok: true, ... }` 或 `{ ok: false, code, message }`，不依赖 throw。常见 code：`missing-baseurl`、`http-401`、`video-timeout`、`not-supported`。
- `canvas_graph_patch` 被拒（lint/原子性）会 throw 一条含原因的消息 → 先 `canvas_graph_view` 再重试。画布版本冲突由 4-guard 处理。
- 删除被引用项目/资产 → 409/`AssetDeleteBlockedError`，消息里带 `dependents`/`hits` 明细；选择级联模式后重试。

## 配置

- 插件级（bundle 行，Schemastery）：`workspaceRoot`、`mediaRoots`、`defaultCanvasId`、`logToolCalls`、`recentLimit`(10)、`trashEnabled`(true)。**`mediaRoots` 默认 `['~/Movies']`**——戏剧/电影类项目用 `media_studio_create_project` 带 `sourcePath` 建在 `~/Movies` 下时，其媒体文件可直接被代理渲染；运行 profile 仍可能以 cordis.patch.yml 覆盖。
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
4. 新建项目由用户在「项目 → 新建」创建，**或由 Agent 调用 `media_studio_create_project` / `media_studio_pick_folder`**（带 `sourcePath` 时项目落在用户自有目录；不带则注册到 workspace）。Agent 操作画布默认落在当前激活项目，勿假设固定 canvasId；切项目请用 `media_studio_open_project`。
5. 素材登记/软引用既可在 GUI 完成，也可由 Agent 主动调用：`media_studio_register_asset` 把画布节点入库；`media_studio_search_assets({ addSoftRef: true, addAssetKey })` 一步完成「跨项目搜索 + 软引用到当前画布」，无需先拷贝文件。
6. 修改服务端后跑全套 `pnpm test`；客户端改动需跑 `typecheck:client`；行为改动重启后在浏览器/curl 复测。
7. 单节点操作优先用 `canvas_node_view / add / update / rename / delete` —— schema 严格、LLM 不易拼错、返回更小。**只**在 2+ 个 op 必须原子完成时才用 `canvas_graph_patch`（如"建节点 + 连线 + 改名"三步走）。
8. `canvas_node_update` 是**浅合并**：要删除某个 data key，请用 `canvas_graph_patch` 的 `updateNode` 把该 key 设为 `undefined`（或 delete + add 重建）。
9. `canvas_node_add` 不会自动把媒体节点入库为素材 —— 那是 `batchAddMedia` + `media_studio_register_asset` 的职责。单节点 add 用于占位符和增量构建。
10. `canvas_node_delete` 会自动清除所有相连边（无论 source 还是 target）；若要保留边，必须先用 `canvas_graph_patch` 单独删边再删节点。
11. **分区优先**：内容分块明确时先建分区（`addRegion`），后续节点都带 `regionId` 落位；同一批建分区 + 落节点（≤60 op）可以一次 `canvas_graph_patch` 完成。需要语义连线时给 `connect` 传 `label`（画布只画线、不显示标签文本）。
12. **分区内整理**：只想整理某个分区的布局时用 `canvas_auto_arrange({ regionId })`，不要用全画布版（会把跨区节点的精心布局打乱）。

## 历史故障复盘：画布展开导致交互卡死（2026-09）

### 现象
画布打开后，Agent 对话输入框无法发送、项目菜单所有操作（重命名/打开本地/打开最近项目）无响应、导出截图无法下载；关闭画布后全部恢复。

### 根因（一条因果链）
```
画布打开 → /canvas/sse + /projects/sse 两个 SSE 长连接建立
→ 加上 DSH 核心的 3-4 个 SSE（plugins/events、voice-mode/stream、bsk-observation/events）
→ 共 6 个长连接，刚好占满 HTTP/1.1 的「每主机 6 连接」限制
→ 所有短请求（rename、delete、status 轮询、聊天发送）排队，永远拿不到连接
→ fetch() 永久挂起（5s+ 无返回）
→ 重命名对话框的 submit() Promise 永不 resolve，按钮永久禁用在「处理中…」
→ 模态遮罩 .ms-menu-backdrop.is-modal (z-index:900, pointer-events:auto) 不消失
→ 全屏遮罩吞掉所有点击 → 表现为「整个 UI 卡死」
```
直接诱发表层是模态遮罩，但**根本原因是 HTTP/1.1 连接池被 SSE 长连接占满**。curl 和 CDP 走的是独立网络栈，不受浏览器渲染进程的 6 连接限制影响，因此服务端一直正常。

### 加重因素
- `NameDialogContent` / `DeleteDialogContent` 定义在 `ProjectApp` 函数内部，每次 SSE 触发父组件重渲染都会产生新函数引用 → React 卸载重挂载对话框 → in-flight 的 submit() Promise 的 setLocalBusy 作用于已卸载组件被忽略 → 新实例 localBusy=false 但 name 重置为原始值。
- 对话框操作成功后不自动关闭，用户需手动点取消，增加了遮罩停留时间。

### 修复方案
1. **合并 SSE 端点（根本修复）**：新增 `/api/media-studio/sse` 统一端点，一个连接同时推送 `canvas-patch` 和 `registry-changed` / `project-open` 事件。客户端 `canvas-bus.ts` 扩展为统一 SSE 总线，`subscribeProjects` 复用同一 EventSource，media-studio 的 SSE 连接从 2 个降到 1 个，为短请求腾出连接。
2. **对话框组件模块化**：`NameDialogContent` / `DeleteDialogContent` 移到模块级别，通过 props 传入回调，避免父组件重渲染时对话框被卸载重挂载。
3. **成功后自动关闭对话框**：submit() 成功后调用 onClose()，不再让用户手动关闭。
4. **保留 30s Promise.race 超时保护**作为兜底。

### 教训与防再犯规则
- **新增任何 SSE 端点前，先数当前已有几个长连接**：DSH 核心约 3-4 个 + media-studio 应 ≤1 个，总和不能接近 6。若需要新的事件流，优先合并到现有统一端点，而不是新开 EventSource。
- **React 组件不要定义在父组件函数内部**：每次重渲染都会产生新引用导致卸载重挂载，丢失 in-flight 状态。定义在模块级，通过 props 传数据和回调。
- **模态对话框操作成功后必须自动关闭**：不要让用户手动关闭，否则任何异常都会留下全屏遮罩。
- **诊断「UI 卡死」时先查 `.ms-menu-backdrop.is-modal`**：这是最常见的直接阻塞源；但不要停在表层，要继续查为什么对话框没关闭（通常是 fetch 挂起 → 连接池满）。
- **浏览器内 fetch 挂起但 curl 正常 = 连接池问题**：用 `lsof -i TCP:<port>` 数 ESTABLISHED 连接，用 CDP `network_requests()` 看 inflight 请求分布。

### 后续优化（2026-09，同一轮修复中完成）
在根本修复（合并 SSE 端点）基础上，进一步把 media-studio 的 SSE 连接从「修复后的 1 个 + SidebarFocusListener 偷偷开的第 3 个」收敛到真正的 1 个，并增加健壮性：

1. **SidebarFocusListener 迁移到统一总线**：原 `sidebar-focus-listener.tsx` 自己开了 `/projects/sse` 监听 `project-focused`，是未被发现的第 3 个 SSE 连接。改为通过 `canvas-bus.subscribeProjectFocused()` 复用统一连接。
2. **删除旧端点**：`/api/media-studio/canvas/sse` 和 `/api/media-studio/projects/sse` 已从服务端移除，客户端无任何引用。统一端点 `/api/media-studio/sse` 是唯一 SSE 入口。
3. **页面不可见时暂停 SSE**：`visibilitychange` 事件监听，标签页后台化时关闭 SSE 释放连接，回到前台时重连。最后一个订阅者离开时自动 detach 监听器。
4. **SSE 重连后主动同步**：EventSource error→自动重连后，主动 fetch 最新 canvas 快照 + registry，覆盖断线期间丢失的事件。
5. **registry-changed 事件防抖**：150ms trailing-edge 防抖，避免项目创建/切换时的连续广播触发 React 重渲染风暴。
6. **对话框超时 30s→10s**：正常请求 2s 内返回，10s 超时 + 友好错误提示更合理。

## 性能契约（必须通过测试用例）

下面这些条款是 **必须通过 `pnpm test` 测试用例保证的**，每条都对应一个或多个 vitest 文件。**任何破坏这些契约的改动都必须随附对应的回归测试，并在 PR 描述里明确说明**。这是把性能优化从「偶发的好心」固化为「代码评审硬约束」的唯一办法 —— 单靠 review 看不出 100ms 和 1s 的差别，CI 跑过的数字才看得见。

### 写入路径（P0-① / P0-②）
- **persist 必须合并**。同一 canvas 在 16 ms 内的多次 `CanvasStore.apply` 只触发一次 `writeFile`。`tests/persistence-debounce.test.ts` 用 `store.persistWriteCount.get(canvasId)` 断言：100 次同步 apply → writeCount ≤ 2。
- **postProcessCanvasPatch 必须批量提交**。N 个 batchAddMedia 视频节点产出的 `updateNode` ops 必须合并成单次 `store.apply`，**不是 N 次**。`tests/post-process-batching.test.ts` 用 apply spy 断言：6 个 video item → 总 apply 调用 = 2（1 batchAddMedia + 1 批量 updateNode）。
- **持久化合并 + 防抖**：拖动 / 批量 patch 期间磁盘 I/O 频率不随节点数线性放大。`tests/perf-budget.test.ts` 守 1000 次同步 apply 在 500 ms 内完成且 writeCount ≤ 2。

### 媒体处理（P1-⑤ / P1-⑥ / P5 / M5-⑤）
- **文件命名必须稳定**。`prepareVideoForCanvas` / `prepareAudioForCanvas` / `prepareImageForCanvas` 对同一 source URL + 同一 cover URL 必须产出同一文件名（基于 sha1 派生）。`tests/stable-filename.test.ts` 断言 hash 稳定性与 16-hex 形状。
- **orphan GC 必须清理不可达文件**。`gcOrphanMedia` 扫描 `<sourcePath>/assets/{clips,characters,scenes,audio}/` 下以 `v-` / `a-` / `i-` 开头的文件，删除那些 basename 不出现在任何 canvas 节点 `data.resultUrl` / `data.poster` 中的文件。`tests/orphan-gc.test.ts` 覆盖引用 / 不引用 / 用户资产 / 缺失目录 / poster 引用五条路径。
- **post-process pipeline 不得因为准备失败把整个 patch 推回去**：`tests/pipeline-regressions.test.ts` 的旧契约依然有效，新加的批量提交不能破坏它（CI 会跑全套）。

### SSE 与客户端渲染（P1-③ / P0-⑩ / P2-⑪ / P2-⑫）
- **SSE 广播按 canvasId 隔离**。`index.ts` 的 `flushBroadcasts` 只把 payload 推到订阅了对应 canvasId 的连接；`routes.ts` 的 SSE handler 按 canvasId 入桶；`canvas-bus.ts` 的 `canvas-patch` 监听器对 `data.canvasId !== state.canvasId` 的 patch 一律丢弃（防止跨画布渲染 bug）。`tests/sse-bucketing.test.ts` + `tests/registry-broadcast.test.ts` 覆盖服务端形状；客户端校验在 `src/client/canvas-bus.ts:191-220`。
- **MediaCanvasContext 与 AdjacencyContext 必须分离**。`MediaCanvasApi` 不再持有 `edgesRight` / `edgesLeft` / `hasUpstreamById` —— 这些字段属于独立 `AdjacencyContext`，拓扑变化不应让所有 memo 化的 card 重渲染。`src/client/canvas-api.ts` 的类型定义和 `src/client/canvas.tsx` 的 Provider 嵌套守住这条线。
- **merge token 必须命中 short-circuit**。`projectedNodeToken` 接受 `cachedDataRef + cachedToken`，当 data 引用相同且 scalar 前缀（id/type/label/position）相同时返回缓存 token，跳过 JSON.stringify。`tests/canvas-rerender-discipline.test.ts` 覆盖三条短路不变量（同 ref 短路、不同 label 不短路、不同 data 不短路）。
- **`useRefreshHandles` 每节点最多一次 rAF 调用**。`src/client/nodes.tsx:80-95` 在 mount 时只 schedule 一次 `requestAnimationFrame(updateNodeInternals)`。媒体 `onLoad` 回调另算，不在 mount 期。这一条靠 `tests/nodes.test.ts` 风格的成本测试比较昂贵，目前仅作为代码 review 约束 —— 若之后引入 React Testing Library，应补一条 `expect(updateNodeInternals).toHaveBeenCalledTimes(1)` 的 mount 断言。

### 服务端依赖扫描与项目打开（P1-⑦ / P1-⑨）
- **`loadAssetIndex` 必须命中 mtime 缓存**。同一文件的两次 read，若 `mtimeMs + size` 指纹未变，第二次返回缓存对象（`Object.is` 稳定）。`tests/search-cache.test.ts` 断言 `await loadAssetIndex(p) === await loadAssetIndex(p)`（同引用），并在 `writeAssetIndex` + `invalidateAssetIndexCache` 后能正确失效。
- **`openProject` 只 restore 目标 canvas**。`CanvasStore.restoreOne(canvasId, sourcePath)` 读**且只读**那一个 `.canvas.json`。`tests/restore-target.test.ts` 用多项目 setup 断言非目标 canvas 的内存状态不被触碰。
- **`dependentsOf` / `scanAssetRefs` 不应深拷贝画布**。`CanvasStore.scanAssetRefs` 与 `countLegacyCopyRefs` 直接遍历内部 `canvases` Map，**不调用** `peek()` / `cloneGraph()`。`tests/dependents-no-clone.test.ts` 覆盖软引用与 legacy `refCopiesFrom` 两条路径。

### 流程要求
- **每次改动 P0/P1 标号对应的代码路径前**先 grep 上面列表，看你即将碰的是哪一条，并在 PR 里 link 相关的测试文件。
- **`pnpm test` 必须全绿**才能提 PR。下面这俩是 **baseline 已知的 5 s timeout flaky**，与本次性能优化无关，**在 PR 里可以接受它们继续红**，但不能引入任何新的失败：
  - `tests/fixes.test.ts > Fix 5: canvas_refresh_node no longer requires upstream edges`（每次都 timeout 5 s）
  - `tests/music-refresh.test.ts > M3: non-dub music node uses generate_music with raw upstream text`（间歇 timeout 5 s）
  - 之所以挂在 5 s 是 vitest 的默认 `testTimeout`，不是断言失败；这两个用例真实运行时大概率是对的，但工具 stub 的 `setTimeout` / `fetch` 路径里某处慢了超过 5 s。
  - **如果你的 PR 让它们从 red 变 green**：恭喜，单独提一个 commit 即可。
  - **如果你的 PR 让它们从 green 变 red，或引入新的 flaky**：你的 PR 必须修掉。
- **每个 PR 至少自己跑 2 次 `pnpm test`**（不要只跑 1 次就以为通过）确认稳定，再决定是「修了 bug」还是「引入 flaky」。
- **新增热点路径**（写入、SSE、媒体处理、依赖扫描、画布渲染）**必须随附回归测试**。如果新加了一个 React 组件级优化（如 memo / re-render discipline），在 PR 描述里点名对应的性能契约条款。

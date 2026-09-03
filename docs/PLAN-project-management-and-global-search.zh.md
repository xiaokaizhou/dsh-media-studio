# dsh-media-studio 开发计划：项目管理（多项目 / 素材库）+ 全局素材搜索与软引用

> 状态：**待审批**（未开始编码）
> 范围：本计划仅覆盖需求分析与开发规划；实际编码在用户审批后进行。
> 目标版本：`0.2.0` → `0.3.0`

---

## 0. 一句话目标

在现有「无限画布 + 媒体节点」之上，把**单个画布**升级为**多项目管理**（每个项目 = 一个画布 + 一套分门别类的素材库），并在顶部提供**全局实时搜索**：输入关键词（如「林晚」），按「当前项目 / 全部项目」分组模糊列出相关素材，点「+」把**其他项目中的素材软引用**进当前画布。

---

## 1. 现状盘点（决定改造的约束）

| 现状 | 文件 | 对本次改造的影响 |
|---|---|---|
| 无“项目”概念；只有画布 id（默认 `main`），持久化为 `<ws>/canvases/<id>.json` | `canvas-store.ts` | 需引入项目注册表，并把“画布=项目画布”建立映射，**保持旧 id 与文件路径不变以兼容存量** |
| 画布为服务端权威：`CanvasStore.apply` 原子批 + 4-guard + 磁盘持久化 + SSE 广播 | `canvas-store.ts` | 项目/素材操作必须沿用同一套「服务端权威 + 单写入队列 + SSE」模式，不可在客户端直接改文件 |
| 服务句柄走 module 单例（`getMediaStudioHandles`），**不能**挂 `ctx.mediaStudio`（Proxy 赋值会抛错） | `service-state.ts` | 新增 ProjectStore 等句柄仍走该单例扩展 |
| 插件服务只依赖 `tools` + `webServer`；REST/SSE 全部走 `ctx.webServer.register({kind:'exact'})` | `index.ts` / `routes.ts` | 新增 REST 路由全部走此通道；SSE 复用现有连接，靠 `event:` 名区分消息类型 |
| 画布工具 4 个（view/patch/auto_arrange/refresh_node），默认 canvasId 回退 `main` | `tools.ts` | 默认画布应解析为「当前激活项目」的画布，旧显式 canvasId 语义保留 |
| 客户端只有 toolbar（加节点按钮）+ ReactFlow；注册为 betterSidebar 标签页，固定绑定 `canvasId='main'` | `client.tsx` / `canvas.tsx` | 标签页需改为订阅「当前激活项目」，新增项目菜单栏 + 搜索框 UI |
| 节点 `data` 自由（prompt/model/resultUrl/status/text/content/height） | `canvas-store.ts` / `canvas-api.ts` | 软引用用新字段 `data.assetRef`（不破坏现有渲染） |
| 本地媒体经 `/api/media-studio/media-file?path=` 代理渲染，仅限 workspaceRoot+mediaRoots 内 | `routes.ts` | 素材文件放 `<ws>/projects/<id>/assets/…` 天然在允许范围内，无需改代理 |
| 仓库无 assets/项目持久结构；生成媒体落在 `<ws>/web-jobs/` | 运行观察 | 素材库登记 = 把文件**复制**进素材目录 + 登记元数据（不移动，避免画布节点 404） |

**文档现状**：README 各语言版仍描述脚手架的 `media-studio_echo`（早已不存在的工具），需在本次一并更正。

---

## 2. 核心概念与数据模型

### 2.1 术语

- **项目 Project**：拥有 1 个主画布 + 1 套素材库的最小工作单元。项目有稳定 `id`（创建后不变）与可改的 `name`。
- **素材 Asset**：素材库中的登记资产，物理文件 + 元数据，按 4 类分库（人物 / 场景 / 音频 / 视频片段）。
- **库内资产归属**：资产默认归属创建它的项目（owner）。软引用方不复制文件。
- **软引用 SoftRef**：项目 A 的画布节点引用项目 B（或全局共享库）的素材，只存 `{assetRef:{projectId, assetId}}`，不复制文件；删除/迁移由引用完整性机制负责。
- **共享库 Shared（`__shared`）**：不可删除的伪项目，用于项目删除时承接「仍被其他项目引用」的资产（迁移而非破坏）。

### 2.2 磁盘布局（新增，存量路径不动）

```
<workspaceRoot>/
  projects.json                        # 项目注册表（唯一权威列表）
  projects/<projectId>/
    assets/
      characters/  <assetId>.<ext>     # 人物资产
      scenes/      <assetId>.<ext>     # 场景资产
      audio/       <assetId>.<ext>     # 音频资产
      clips/       <assetId>.<ext>     # 视频片段
      index.json                       # 本项目资产索引（元数据，不存二进制）
    …（画布仍在旧位置）
  shared-assets/                       # __shared 伪项目的资产根（结构与 projects/<id>/assets 相同）
  canvases/<canvasId>.json             # 画布持久化（不变；canvasId == 项目 id）
  trash/<projectId>_<timestamp>/       # 删除时的回收目录（默认软删除）
  web-jobs/                            # 生成媒体落点（不变）
```

要点：
- **文件路径与展示名解耦**：资产文件名 = `<assetId>.<ext>`，重命名只改元数据 → 引用永不因改名失效（这是本计划最重要的一个设计决定）。
- **项目 id == 画布 id**：迁移期旧画布 id（如 `main`）直接成为项目 id，`canvases/main.json` 原地不动，零迁移风险。

### 2.3 注册表（`projects.json`）

```jsonc
{
  "version": 1,
  "activeId": "p-xxx",
  "recent": ["p-xxx", "main", "p-yyy"],          // 最近打开，≤ recentLimit(默认10)
  "projects": {
    "p-xxx": { "id": "p-xxx", "name": "林晚传 · 第一集",
               "createdAt": "…", "updatedAt": "…", "lastOpenedAt": "…",
               "legacy": false }
  }
}
```

### 2.4 资产索引（`projects/<id>/assets/index.json`）

```jsonc
{
  "version": 1,
  "assets": [{
    "id": "a-…", "kind": "character" | "scene" | "audio" | "clip",
    "name": "林晚 · 半身像", "file": "a-xxx.png",
    "tags": ["女主", "古装"], "bytes": 123456,
    "meta": { "width":…, "height":…, "durationS"?:… },      // 媒体元信息（音频/视频）
    "origin": { "type": "generated", "model": "…", "prompt": "…" }
             | { "type": "canvas", "canvasNodeId": "n-…" }   // 由画布登记
             | { "type": "imported", "sourcePath": "…" }
             | { "type": "pasted" },
    "refCopiesFrom"?: { "projectId": …, "assetId": … },      // 硬复制溯源（仅信息性）
    "createdAt": "…", "updatedAt": "…"
  }]
}
```

### 2.5 软引用节点（画布节点 data 扩展）

```ts
// 现有节点类型/渲染不变；data 增加：
{
  assetRef: { projectId: string, assetId: string },   // 权威来源
  assetKind: 'character' | 'scene' | 'audio' | 'clip',
  resultUrl: '/api/media-studio/media-file?path=projects/<owner>/assets/<cat>/<file>',
  // 其余字段沿用：status:'done'、model、prompt(登记时的原prompt)…
}
```
- 节点类型映射：character/scene → `image` 节点；audio → `music`；clip → `video`。
- 卡片左下角新增来源徽标「素材 · <来源项目名>」；media 卡上的「重新生成」对软引用节点禁用（防止把别人的资产改了）。

---

## 3. 功能规格

### 功能一：画布顶部「项目」菜单（含项目生命周期 + 素材库）

#### 菜单结构（工具栏左侧新加）

```
[项目 ▾]  [＋加节点…(原工具栏右移)] …  [全局搜索框…]  [vN · live]
 ├─ 新建项目            → 对话框：名称(可空=自动“未命名项目 N”)
 ├─ 打开 ▸             → 全部项目列表（名/更新时间/资产数），点击切换
 ├─ 最近打开 ▸          → ≤10 条，最新在前；顶部可“清空最近记录”
 │                        （条目在项目被删除后自动剔除）
 ├─ ──────────
 ├─ 当前：<项目名>      → 状态显示（只读，可右键重命名入口之一）
 ├─ 重命名              → 行内/对话框改名（合法性校验见下）
 └─ 删除                → 先做依赖分析再弹确认（见 3.1.2）
```

#### 3.1.1 动作语义

| 动作 | 服务端行为 | UI 行为 |
|---|---|---|
| 新建 | 生成 `p-` 前缀稳定 id；建 4 类资产目录 + 空 index.json；注册表新增；`activeId` 切到新项目；空画布即时可用；写 `projects.json` | 切换当前项目并清空画布视图；自动 fit |
| 打开 / 最近打开 | 校验存在 → `lastOpenedAt=now`、置顶 recent（去重、截断到 recentLimit）→ 广播 `project-open` | 画布重新订阅该项目 SSE 与快照；恢复该项目记忆的视口 |
| 重命名 | 只改注册表 `name`；**不改目录/画布文件名/任何引用**；校验：非空、≤64 字符、不得含 `/\:*?"<>|`（仅避免未来路径复用问题）、同 id 不重名限制不做（允许多项目同名） | 输入框校验错误内联提示 |
| 删除 | 见 3.1.2 | 依赖分析结果对话框 + 模式选择 |

#### 3.1.2 删除：引用依赖分析（需求 1 括号内要点的完整化）

**分析算法**（服务端，删除前置）：
1. 遍历注册表中**其它**每个项目 Q 的画布节点：凡 `data.assetRef.projectId === P.id` 即命中；收集 `{引用项目, 节点, 资产}`。
2. 同一资产被多处引用按资产聚合（去重计数，展示引用项目清单 + 各项目内节点数 + 节点预览标签）。
3. 附带信息（非阻断）：统计「本项目资产被哪些项目**硬复制**过」（`refCopiesFrom` 溯源）——展示但**不阻止**（硬复制已是独立文件）。

**删除确认对话框内容**（无引用时简化为普通确认）：
- 头部：将删除项目「名称」及其 N 个素材、画布（引用影响列出来）。
- 若检测到引用：展示分组列表（引用项目 × 资产缩略图 × 节点数），并给出三种模式单选：

| 模式 | 行为 | 适用 |
|---|---|---|
| 取消（默认） | 不执行任何删除 | 保守默认，防止误伤他人项目 |
| 迁移到共享库后删除 | 把**被引用的资产文件**复制/移动进 `__shared`，重写引用项目画布中所有 `assetRef.projectId = __shared` 并持久化；其余资产与项目本体进回收站 | 想让被引用的好素材活下来（推荐的数据安全路径） |
| 强制删除并断链 | 各引用节点原地标记为「素材缺失(broken)」，原画布渲染占位卡；项目整体进回收站 | 用户明确要清理干净 |

- **删除默认走回收站**：项目资产目录移动到 `<ws>/trash/<id>_<ts>/`，注册表移除、recent 剔除、**内存画布状态 evict**（含 `CanvasStore` 新增 `deleteCanvas(id)`，防止幽灵 apply 复活）。对话框内提供「立即彻底删除（跳过回收站）」显式勾选项。回收站恢复 UI 不在本期（见边界），误删可手工从 trash 找回。
- 若被删项目是 `activeId` → 自动打开 recent 中最近的一个项目，并向所有标签页广播 `project-open`；无任何项目时进入空态。

**资产级删除复用同一引擎**：素材库面板提供资产删除（或改名），服务端走**同一个 `analyzeDependents` + 模式对话框**，即「删除资产」= 本项目删除引擎在单资产粒度上的复用 → 保证删除语义全插件一致。

#### 3.1.3 素材库管理（新增但最小化，功能一/二的桥梁）

没有「素材入库」就没有可搜的库。提供：
- 画布 media 卡 hover 工具条新增「存入素材库」：弹分类选择（人物/场景/音频/视频片段，按节点类型给默认）+ 名称（默认取卡片标题）。服务端把文件**复制**进对应目录、写入 index.json（记录 origin.canvasNodeId 防重复登记）、广播 `asset-changed`。
- 顶部「素材库」视图（项目下拉里或工具栏按钮打开的面板）：按 4 类分组列出本项目资产（缩略图/名称/标签/大小/来源/更新时间）；操作：改名、编辑标签、（带依赖分析的）删除、硬复制到其他项目。

### 功能二：全局实时搜索 + 软引用

#### 3.2.1 可搜索语料（见「待确认 Q2」，默认=库资产 + 画布成品自动可搜）

- **A 类：各项目素材库登记资产**（权威来源 index.json）。
- **B 类：画布上的媒体成品**（各项目画布中 `status==='done'` 且有 resultUrl 的 image/video/music 节点；排除已登记入库的 origin 节点去重；不包含 text/note）。B 类在结果中标注「画布素材 · 未入库」，排序靠后。

#### 3.2.2 交互规格

```
输入框：⌘/Ctrl+K 聚焦，输入 ≥1 字符实时(防抖 ~180ms)查询
┌─ 搜索结果下拉（点击外部/Esc 关闭）──────────────────────┐
│ “当前项目 · 林晚传”  (n)                                  │
│  [缩略图] 林晚 · 半身像   [人物]  本项目  2.3 MB   [+ 添加] │
│  ……                                                        │
│ “全部项目” (共 m)                                          │
│  [缩略图] 林晚 · 战斗立绘  [人物] 项目「番外篇」 · 3 天前 [+ 添加]│
│  ……                                                        │
│  ↕ 上下键选择 · Enter 添加 · 已显示 20/47 · 按 ⌘K 重新聚焦 │
└──────────────────────────────────────────────────────────┘
```

- **分组**：固定两段——「当前项目（active）」与「全部项目（含当前，展示来源项目徽标）」。任一为空则不显示该组。每组上限 `searchLimit`(默认 20) + 计数，超出显示「还有 N 项」。
- **模糊匹配与排序**：名称命中（权重最高）> 标签 > 登记 prompt/来源文件名；支持子串 + 简单编辑距离容错（CJK 以子串为主）；组内按分数 → 最近更新排序。
- **点击「+ 添加」→ 软引用入库**（默认行为）：
  1. 若目标资产 owner ≠ 当前项目 → 在当前画布新增软引用节点（`assetRef`，自动空位），复用既有原子批 + SSE 通道；操作成功即画布出现该素材卡 + toast。
  2. 若当前项目已引用同一资产 → 允许重复添加（同一素材可在画布多处使用），但 toast 提示「已引用 N 次」；同一资产同一项目中已有 N 处引用时面板显示小角标计数。
- **次级动作**：「复制到本项目素材库（硬引用）」——图标按钮或行尾小菜单：把文件复制进当前项目对应分类并登记，随后当前项目拥有独立副本（用于要长期改/再生成/离源可用的场景）。复制件带 `refCopiesFrom` 溯源。
- **B 类（画布成品）素材的「+」= 直接硬复制入库**（不软引用节点本身，因为源是随时可被删的草稿节点，软引用会引向脆弱目标）。

#### 3.2.3 服务端搜索

- `GET /api/media-studio/search?q=…&scope=all|project`，服务端权威计算，返回分组 JSON（含命中资产元数据 + thumb 代理 URL + alreadyRefCount）。
- 索引策略：内存缓存资产元数据（启动时扫描 + 事件驱动增量失效）；B 类画布素材按「项目画布快照 + mtime 缓存、TTL ~2s」懒扫描，不常驻。
- 无 `q`/空结果给明确空态文案（「未找到与 xx 相关的素材，试试在项目中先登记/生成」）。

#### 3.2.4 引用完整性（软引用的地基，贯穿全局）

- **ReverseRefIndex**（内存）：`(ownerProjectId, assetId) → [{refProjectId, nodeIds}]`。增量维护：挂在 `CanvasStore.apply` 的 diff 后钩子上（addNode/batchAddMedia 带 `assetRef` 的、updateNode 变更 assetRef 的、deleteNode/deleteEdge 移除的）。启动时全量重扫重建。
- **失效处理**：owner 资产文件被删/项目被删 → 相关节点按上文的 broken 占位渲染，提供「清除节点 / 从素材库重新添加」；搜索面板与素材库自动刷新。
- **改名不影响引用**（文件=id 名）；**资产文件被“同步更新”**（见 3.3）不产生新 id，只改文件 + updatedAt。

### 3.3 附加：素材库资产同步（防“重新生成后库版本过期”）

media 卡点击「重新生成」成功后，若该节点曾被登记入库，服务端在完成回调里比对新文件与库文件的差异：库文件过旧时，素材库条目标「有更新」，卡片提供「更新库文件」一键替换（保留旧文件进 trash 备份，updatedAt 更新；不建多版本体系，本期不做版本回滚 UI）。

---

## 4. 服务端架构

### 4.1 新增模块（src/）

```
project-store.ts    ProjectStore —— 注册表读写(串行队列)、项目CRUD、active/recent、回收站移动、
                                    资产目录模板、dependents 分析、evict canvas、__shared 迁移重写
asset-store.ts      AssetStore —— 资产索引读写、入库(登记/硬复制)、改名/标签、删除(dependents复用)、
                                   库文件同步、thumbnail 元数据整理
ref-registry.ts     ReverseRefIndex —— 增量维护 + 启动重建 + broken 检测工具
search.ts           SearchService —— 语料聚合(库+画布懒扫)、模糊匹配与排序、分组分页、缓存失效
routes.ts           (扩展现有) REST + SSE 事件
config.ts           (扩展) 新配置项
tools.ts            (扩展, 见 4.4)
service-state.ts    (扩展句柄集合)
```

### 4.2 REST 路由（全部挂在既有 `/api/media-studio` 前缀，`kind:'exact'`）

```
GET   /projects                     → { projects:[…按lastOpenedAt排], recent:[…], activeId }
POST  /projects {name?}             → 新建并激活（返回项目+模板已建）
POST  /projects/:id/open            → 激活+置顶 recent
POST  /projects/:id/rename {name}
GET   /projects/:id/dependents      → 引用分析（删除预检）
POST  /projects/:id/delete {mode:'trash'|'permanent', cascade:'cancel'|'migrate-shared'|'break-refs'}
GET   /assets?projectId=            → 项目素材列表(4类分组)
POST  /assets/register {projectId, category, from:{nodeId|url|clipboardDataUrl}, name?, tags?}
POST  /assets/:pid/:aid/update {name?, tags?}
POST  /assets/:pid/:aid/sync-file {canvasNodeId}     // “更新库文件”
GET   /assets/:pid/:aid/dependents  → 资产级依赖预检
POST  /assets/:pid/:aid/delete {cascade:…}
POST  /assets/copy {from:{pid,aid}, toProjectId, category?}    // 硬复制入库
POST  /refs {assetProjectId, assetId}                  // 软引用 → 当前画布加节点
GET   /search?q=&scope=all|project
POST  /trash/restore {…}  （可选，见边界）
```

写操作全部返回权威 JSON（含新版本号/新节点 id），并触发 SSE；错误统一 `{ok:false,error}`，沿用现有风格。

### 4.3 SSE 事件（复用现有连接通道，按 `event:` 名分发）

现有连接 `/api/media-studio/canvas/sse?canvasId=` 扩为同时监听项目事件（新端点 `/api/media-studio/projects/sse` 仅推注册表级事件；或同一 EventSource 双事件名——实现时取改动小者，推荐**独立 projects/sse**，避免画布连接因切项目反复断开）：

```
event: projects-changed   {type, registry:{activeId,recent,projects:minimal}}
event: project-open       {projectId, name}          // 所有标签页跟随切项目
event: asset-changed      {projectId, assetIds[], change:'registered|updated|deleted|moved'}
event: canvas-patch       (现有不变)
```

### 4.4 工具层（模型可见性红线）

- 画布 4 工具语义微调：`canvasId` 缺省解析 = **当前激活项目 id**（替换死值 `main`）；显式传 canvasId 不变。
- 新 **agent 工具暂不引入**（REST/UI 先行）：一旦引入任何项目/素材工具，其输出为模型可见内容，须遵守「模型可见 ⟺ 会话日志可重建」，补 SessionEventMap 会话事件 + `logToolCalls` 记录（现有 config 已有该开关可沿用）。本期在计划尾部单列「后续可选 agent 工具：project_list / asset_search / asset_register」并标注此约束。

### 4.5 并发与一致

- 所有项目/素材写操作经 **ProjectStore 串行队列**（Promise 链），与 CanvasStore 的版本守卫互补；canvas patch 到已删除项目 → apply 拒绝（store 已 evict + registry 校验）。
- 多标签页并发 rename/delete：事件驱动，标签页状态以服务端广播为准（同现有 canvas-patch 回灌模型，不做本地乐观）。
- 写盘失败沿用 canvas-store 的做法：非致命、打日志、下次写重试；注册表损坏时启动日志告警并提供「重建/备份」提示，绝不静默清空。

---

## 5. 客户端架构

### 5.1 新增/调整文件（src/client/）

```
canvas.tsx         (改造) 顶部从单行 Toolbar 升级为 Menubar 布局；按 activeProjectId 订阅画布；
                        项目切换/删除事件处理；每项目视口记忆(持久化 localStorage)
i18n.ts            (新) 极简 zh/en 键值表 + t(key) + 语言解析/覆盖
menubar.tsx        (新) 「项目」下拉 + 最近打开 + 重命名/删除入口 + 当前项目名徽标（文案走 i18n）
dialogs.tsx        (新) 新建/重命名/删除(含依赖分析结果与三模式)/通用确认对话框
global-search.tsx  (新) 搜索输入 + 下拉结果面板（分组/缩略图/加号/次级复制） + ⌘K + 键盘导航
asset-panel.tsx    (新) 素材库面板（4 类分组浏览 + 操作）
softref-node.tsx   (新或并入 nodes.tsx) 软引用徽标/禁止重新生成/broken 占位渲染
projects-api.ts    (新) REST 封装 + 类型（对齐 canvas-api 的模式，浏览器端不引 node 模块）
canvas-styles.ts   (扩) menubar / 下拉 / 对话框 / 素材面板 / broken 卡样式
```

- 组件不引服务端代码；类型在 `projects-api.ts` 镜像声明（沿用 canvas-api.ts 的做法与注释理由）。
- 保持「所有用户操作 → REST → 服务端权威 → SSE 回灌」单一漏斗；画布内项目相关交互（搜索添加 = 软引用节点）最终仍走 `store.apply`，保证 agent 的 `canvas_graph_view` 能看到与用户一致的结果。
- 菜单/对话框复用现有 `ms-clear-confirm-*`、`ms-connect-menu-*` 的视觉语言；下拉用 portal 到 body（沿用 CreateMenu 的 `contain` 规避经验）。

---

## 6. 需求外补充点（帮你想全的清单）

1. **id/文件路径与显示名解耦** —— 素材与项目改名零引用破坏，是软引用能成立的前提。
2. **「存入素材库」登记流程** —— 没有它，老工作流产出的画布素材永远进不了搜索语料；同时解决重复登记（origin 去重）。
3. **删除依赖分析做成“资产级 + 项目级共用一个引擎”**，并给三级模式（取消/迁共享/断链），避免“引用者删除”的单一路径。
4. **回收站式软删除**（默认），误删可找回；彻底删除为显式选项。
5. **画布成品(B类)与库资产(A类)区分对待**：「+」对 B 类做硬复制、对 A 类做软引用，规则一致且不会引向易失目标。
6. **broken 占位与引用自愈** —— 源删除后引用节点不白屏，提示 + 清理/重新添加；反向索引保证删除前能精确列全影响面。
7. **切项目状态**：每项目记忆视口；删除当前项目自动切到最近项目；多标签页跟随广播。
8. **⌘/Ctrl+K 聚焦搜索 + 键盘上下/Enter/Esc**（类 VS Code 命令面板习惯）。
9. **搜索结果去重与角标**：同一素材重复添加给计数提示；每组结果上限 + “还有 N 项”。
10. **“库文件过期”同步**（重新生成后一键更新库文件）——避免软引用/复用素材悄然陈旧。
11. **注册表与索引损坏的自检/自愈与日志**；**配置项不硬编码**（recentLimit/searchLimit 可配）。
12. **存量兼容**：旧 `main` 画布自动成为首个项目；旧任意 canvasId 仍可被工具显式访问；README 五语版本与 AGENTS.md 同步更正（现状文档已严重过期）。
13. **删除时也列出「曾被硬复制」的消费方**（信息性），并提示共享库的存在意义。
14. **素材分类默认值智能化**（image→场景、video→片段、audio→音频，可在保存对话框改选人物）。

---

## 7. 明确不做（本期边界，避免无限扩张）

- 不做回收站恢复 UI（trash 目录可手工恢复；restore 接口留接口位）。
- 不做资产多版本/历史记录 UI（只做“同步最新”）。
- 不做多画布/每项目多 storyboard（1 项目 = 1 主画布；工具仍可访问遗留任意 canvasId 画布）。
- 不做账号/多用户、云同步、素材直传文件选择器（先支持：画布登记、剪贴板、URL）。
- 复杂 i18n 不做 → 但**做极简 i18n（zh/en）**：客户端 `i18n.ts` 键值表 + `t(key)`，语言 = 浏览器语言，localStorage `dsh-media-studio:lang` 可覆盖（项目菜单底部提供切换）。范围覆盖本项目全部用户可见文案，存量英文文案（工具栏/节点菜单/视图栏等）随 M1–M4 渐进迁入键值表，M4 收口 100%。
- 不引入 pinyin/第三方搜索库；模糊 = 子串 + 简单编辑距离（可后补拼音首字母）。
- 素材生成/再生仍然全部经由 dsh-llm-multimodal，本插件不做任何 LLM 调用面变更。

---

## 8. 兼容与迁移

1. **首启迁移**：注册表不存在且 `canvases/` 下有文件 → 以每个 canvas id 建项目（legacy 标记），`main` 设为 active；写入 `projects.json`。此后工具默认解析即走 active 项目。
2. 注册表存在但 canvases 目录多了游离画布 → 不自动建项目（日志提示），避免误建。
3. 资产目录与 index.json 不一致（手工删文件/损坏）→ 启动自检：报告缺失项；不做自动删除，提供 repair 动作日志。
4. `config.workspaceRoot` 的 `~` 展开逻辑复用现有 `expandRoot`；`mediaRoots` 追加资产目录无必要（assets 已在 workspaceRoot 下）。

### 8.1 新增配置（config.ts，Schemastery）

| 键 | 默认 | 说明 |
|---|---|---|
| `recentLimit` | `10` | 最近打开最大条数（需求上限） |
| `searchLimit` | `20` | 每组搜索结果上限 |
| `searchDebounceMs` | `180` | 客户端防抖（其实可放客户端常量，放 config 便于调） |
| `trashEnabled` | `true` | 删除先进回收站 |
| `registerCanvasMediaInSearch` | `true` | 画布成品(B类)是否可搜（对应 Q2 开关） |

---

## 9. 里程碑与验收（每阶段可独立交付/回退）

### M0 — 服务端数据地基（项目注册表 + 迁移）
交付：`projects.json` 读写/串行队列、active/recent、首启迁移、模板目录创建、REST(projects CRUD + dependents 预检 + delete 三模式)、`deleteCanvas` evict、projects SSE、config 新键。
验收：curl 走通「新建→改名→查 dependents(空)→回收站删除→recent 剔除→active 自动切换」；旧 `main` 数据无损；`pnpm test` 新增用例绿。

### M1 — 项目菜单 UI + 激活切换
交付：menubar「项目」下拉全项、最近打开(≤10)、重命名/删除对话框（含引用影响展示与三模式）、激活项目切换与多标签页广播跟随、每项目视口记忆、空态。
验收：浏览器手动全流程；重命名后刷新不丢；删除有引用项目时对话框列出引用明细；⌘Z 等画布能力在切换后不回灌错项目。

### M2 — 素材库 + 登记
交付：AssetStore、素材库面板、画布卡「存入素材库」、资产改名/标签/删除(资产级 dependents)、硬复制、库文件同步、「同步更新」提示。
验收：把生成的图/视频/音频分别登记到 4 类目录；索引 json 与文件一致；重复登记被去重；资产级删除引用方被列出。

### M3 — 全局搜索 + 软引用
交付：SearchService（A+B 语料、模糊排序、分组、计数）、搜索下拉 UI(⌘K/键盘/加号/次级复制)、软引用节点渲染与徽标、ReverseRefIndex 增量维护、broken 占位与自愈操作。
验收：项目 A 搜「林晚」实时出 A 库与 B 项目的结果并按分组展示；点「+」A 画布出现素材卡且 `canvas_graph_view` 可见同一节点；删除 B 项目（有 A 引用）→ 对话框三模式各验证一次（迁移共享后 A 图仍显示 / 断链后 A 出 broken 占位）；重复添加有计数提示。

### M4 — 加固、文档、回归
交付：README 五语版本更正 + 新功能章节、AGENTS.md 更新、新增 UI 文案方案落地、vitest 全绿 + 客户端类型检查脚本化、全量手动回归（含多标签页/重启持久化）、打包冒烟（`pnpm pack` 装干净 profile 验证，含 client 注入）。
验收：`dsh-plugin-dev check` 通过、重启后项目/素材/画布完整、旧工具文档与行为一致。

---

## 10. 风险与对策

| 风险 | 对策 |
|---|---|
| 迁移破坏存量画布 | id/路径全不变；只加注册表；首启只读迁移 + 单测覆盖 |
| 软引用悬垂（源删除竞态） | 删除前 dependents 分析强制展示；broken 占位兜底；引用方画布持久化原子批 |
| canvas patch 与项目删除竞态 | ProjectStore 串行队列 + store evict + apply 前 registry 校验 |
| 画布成品自动入索引的噪音/性能 | B 类限 done+有url、mtime 缓存 TTL、每项目懒扫、结果排序靠后；可用 Q2 开关整体关闭 |
| 多标签页状态漂移 | 项目事件全走 SSE 广播回灌，不做本地乐观；测试覆盖双标签页 |
| UI 文案语言混乱 | 见 Q1，先定文案方案再开发 M1/M3 UI |
| 工具栏行宽有限（窄 tab ~280px） | menubar 用紧凑字形 + 下拉承载二级；搜索框自适应宽度，必要时用图标展开式 |

---

## 11. 决策确认（用户审批结果，2026-09-04 已锁定）

| 项 | 结论 |
|---|---|
| Q1 UI 文案语言 | **中英双语（极简 i18n zh/en）**，浏览器语言 + localStorage 覆盖；存量文案渐进迁入，M4 收口 |
| Q2 可搜索语料 | **素材库资产 + 画布成品自动可搜**（B 类标注“画布素材·未入库”、靠后、可配开关 `registerCanvasMediaInSearch`） |
| Q3 删除策略 | **有引用默认拦截 + 三模式对话框；删除先进回收站**（`trashEnabled=true`） |
| 审批 | **通过，按 M0→M4 顺序开发**（每阶段交付后同步进度） |

> 备注：`registerCanvasMediaInSearch` 默认 `true` 使 Q2 生效；M0 阶段先落地最近打开上限与回收站开关两个配置键，搜索相关键随 M3 一并加入。

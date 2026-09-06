# 技能创建文档：`media-studio-video-director`

> **基于 dsh-media-studio 画布的视频创作流程实时可视化与视频内容创作技能**
> 版本：v1.0 · 日期：2026-09-07 · 状态：设计定稿 + 已实例化
> 实例化位置：`~/.workbuddy/skills/media-studio-video-director/`

---

## 0. 文档导航

| 章节 | 内容 |
|---|---|
| 一、技能定位 | 解决什么问题、不解决什么、与现有插件的边界 |
| 二、能力架构 | 三层架构 + 七大组件 |
| 三、节点拓扑规范 | 角色字典、data 契约、边契约、Region 规范（需求 1） |
| 四、父子驱动刷新契约 | 每个节点如何被父节点引导刷新（需求 2） |
| 五、工程化方法论 | 视频创作的 "superpower" 工程框架（需求 3） |
| 六、一致性保障方案 | 四锚点模型 + Lint + 事故处置（需求 4） |
| 七、衔接连贯性方案 | 镜头语言、转场、对白、BGM、首尾帧（需求 5） |
| 八、工具与能力自动发现 | 能力矩阵、探测流程、降级矩阵（需求 6） |
| 九、内容类型模板 | 短剧 / 微电影 / 创意视频 / 商品广告 / AI 漫剧 |
| 十、九阶段工作流 | 端到端执行规程 |
| 十一、交付物清单与验收 | 文件结构、自检、演进路线 |

---

## 一、技能定位（Positioning）

### 1.1 一句话定位

> **把视频创作从"拼 prompt 撞运气"，升级为"可编译、可增量重生成、可 lint 的画布工程"。**

### 1.2 问题陈述

当前 AI 视频创作的四大结构性缺陷：

| 缺陷 | 表现 | 根因 |
|---|---|---|
| **一致性漂移** | 同一个角色第 3 镜就不是同一张脸 | 设定只存在于对话上下文，模型每次重新"猜" |
| **流程不可见** | 用户不知道做到哪一步、哪张图在生成 | 生成过程散落在聊天流里，没有结构化载体 |
| **无法局部重做** | 改一处要全片重生成 | 内容与依赖没有建模，做不到增量编译 |
| **能力不确定** | 不知道当前环境有没有文生视频、能不能声音克隆 | 开工前没有能力探测，缺能力时直接失败 |

### 1.3 边界（做什么 / 不做什么）

```
┌───────────────────────────────────────────────────────────┐
│  media-studio-video-director（本技能）                     │
│  · 内容类型识别与流程编排                                   │
│  · 画布拓扑结构设计（Region / Node / Edge / data schema）   │
│  · 一致性锚点体系与 Lint 规则                               │
│  · 连贯性设计（镜头语言 / 转场 / 对白 / BGM）               │
│  · 能力探测与降级决策                                       │
└───────────────────────────────────────────────────────────┘
        ↓ 调用                              ↓ 调用
┌──────────────────────────┐   ┌──────────────────────────────┐
│ dsh-media-studio         │   │ dsh-llm-multimodal           │
│ · canvas_graph_view      │   │ · generate_image              │
│ · canvas_graph_patch     │   │ · generate_video              │
│ · canvas_refresh_node    │   │ · generate_tts                │
│ · canvas_auto_arrange    │   │ · generate_music              │
│ · media_studio_* 项目/素材│   │                              │
└──────────────────────────┘   └──────────────────────────────┘
```

**明确不做**：
- 不实现任何生成器（不重复造 `generate_*`）。
- 不改 `dsh-media-studio` 代码（全部能力通过现有工具 + `data` 扩展字段实现，零改动落地）。
- 不做视频合成/剪辑的**创作决策**（只产出 `edit-plan` 时间轴指令交给 `scripts/assemble_timeline.py` 执行，或由人工剪辑）。执行器 `assemble_timeline.py` 把 `edit-plan` 编译成成片，并依据本机 ffmpeg 能力自动降级（详见 `references/editing-and-assembly.md`）。

### 1.4 目标用户与触发场景

| 场景 | 触发语 |
|---|---|
| 从零创作 | "做一条 30 秒的手冲咖啡广告" |
| 剧本可视化 | "把这个短剧剧本做成 AI 漫剧" |
| 续做 / 修片 | "第 5 镜角色脸变了，重做一下" |
| 跨项目复用 | "用上次那个角色形象再拍一条" |
| 流程可视化 | "在画布上看到整个创作流程" |

### 1.5 成功标准

- 同一角色在 10 个以上镜头中保持可辨识的一致外貌（人工盲评通过率 ≥ 90%）。
- 单个上游修改只触发必要的下游重生成（重生成节点数 / 总节点数 ≤ 40%）。
- 用户全程可在 Media Studio 画布看到拓扑结构与实时生成状态（SSE 回灌）。
- 缺少任一生成能力时，能自动降级为可交付方案而不是失败。

---

## 二、能力架构（Capability Architecture）

### 2.1 三层架构

```
┌─ L3 导演编排层 · 本技能 ─────────────────────────────────────────┐
│                                                                  │
│  ① Intent Router        内容类型识别 → 模板选择                   │
│  ② Template Compiler    模板 → 画布 op 批次（Region/Node/Edge）   │
│  ③ Refresh Orchestrator 拓扑序刷新 + 脏标记传播 + prompt 重置     │
│  ④ Consistency Keeper   四锚点注入 + 一致性 Lint                  │
│  ⑤ Continuity Gate      镜头语言/转场/对白/BGM 设计与校验         │
│  ⑥ Tool Auto-Discovery  能力矩阵探测 + 降级决策                   │
│  ⑦ Delivery Compiler    生成 edit-plan 时间轴 + qc-report         │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
                              ↓
┌─ L2 画布结构层 · dsh-media-studio ───────────────────────────────┐
│  CanvasStore（服务端权威，4-guard 校验 + 原子批 + 磁盘持久化）      │
│  Region 分区 · Node 节点 · Edge 依赖 · Asset 素材库 · SSE 实时回灌  │
└──────────────────────────────────────────────────────────────────┘
                              ↓
┌─ L1 生成能力层 · dsh-llm-multimodal ─────────────────────────────┐
│  generate_image · generate_video · generate_tts · generate_music  │
└──────────────────────────────────────────────────────────────────┘
```

### 2.2 七大组件职责

| 组件 | 输入 | 输出 | 关键规则 |
|---|---|---|---|
| **① Intent Router** | 用户意图 | 内容类型 + 模板 | 5 类模板（短剧/微电影/创意/广告/漫剧），可组合 |
| **② Template Compiler** | 模板 + brief | `canvas_graph_patch` op 批次 | 单批 ≤60 op；非种子节点 `addNode` 与 `connect` 同批 |
| **③ Refresh Orchestrator** | 脏节点集合 | 按拓扑序的刷新序列 | **刷新前 `prompt = deltaIntent` 重置**；只刷脏节点 |
| **④ Consistency Keeper** | 圣经节点 | 锚点边 + Lint 报告 | 图锚优先于文锚；bible 直连到每一层 |
| **⑤ Continuity Gate** | shot-list | 转场/对白/BGM 设计 | 180° 轴线、30° 规则、J/L-cut、BPM 对齐 |
| **⑥ Tool Auto-Discovery** | 运行环境 | 能力矩阵 + 降级方案 | 静态 → 试探 → 惰性三级探测；缺能力必须告知用户 |
| **⑦ Delivery Compiler** | 全部成品 | `edit-plan` + `qc-report` | 时间轴可直接交付剪辑 |

### 2.3 状态与可视化

画布是**服务端权威**的单点状态源：

```
Agent 工具 ─┐
            ├→ CanvasStore.apply() → 落盘 canvases/<id>.json + SSE 广播
浏览器 UI ──┘                                    ↓
                                    浏览器实时回灌（用户看到卡片转圈→完成）
```

- 每次 patch 落盘并 `version++`，SSE 带 `event:` 行推送 `canvas-patch`。
- 用户在 DSH Web GUI 的 Media Studio 标签页**实时看到**拓扑与生成进度。
- 每个项目记忆视口位置，切回来恢复镜头。

---

## 三、节点拓扑规范（需求 1）

> **事实基线**：`dsh-media-studio` 画布节点类型只有 5 种 —— `text | image | video | music | note`。
> 本规范**不新增节点类型**，全部语义通过 `data` 扩展字段承载 —— **零代码改动即可落地**。

### 3.1 拓扑总览

```
R-flow     [brief] ─┬────────────────────────────────────────────┐
                    │                                            │
R-bible   [style-bible][character-bible][scene-bible][prop-bible][voice-bible]
              │风格锚       │角色锚        │场景锚      │道具锚     │声音锚
              │            │             │            │            │
R-script  [outline]──[script]──[shot-list]──[shot-prompt S01..Sn] [mood-brief]
                                                  │镜头意图          │情绪
R-assets  [character-sheet][scene-sheet][prop-sheet]
              │角色锚(图)      │场景锚(图)     │道具锚(图)
              └───────────┬───────────────┘
                          ▼
R-board              [keyframe S01..Sn] ←── 风格锚
                          │首帧参考(I2V)
R-clips              [shot-clip S01..Sn] ←── 镜头意图 + 风格锚 + 时长预算
                          │
R-audio   [dub S01..Sn] ← 对白来源 + 声音锚      [bgm] ← 情绪 + 风格锚    [sfx]
                          │
R-final              [edit-plan] → [qc-report]
```

### 3.2 角色字典（`data.role`）

#### 源码层（`text` / `note`）

| role | type | 父节点 | 内容字段 | 说明 |
|---|---|---|---|---|
| `brief` | text | — **种子** | `text` | 目标/受众/平台/总时长/画幅/调性/禁忌 |
| `capability-profile` | note | — **种子** | `content` | Phase 0 能力矩阵 |
| `style-bible` | text | brief | `text` | 画风/色彩/焦段/画幅/光照/**负面约束** |
| `character-bible` | text | brief, style-bible | `text` | 全片角色文字真源 |
| `scene-bible` | text | brief, style-bible | `text` | 全片场景文字真源 |
| `prop-bible` | text | brief, style-bible | `text` | 道具/产品规格书 |
| `voice-bible` | text | brief | `text` | 音色/语速/语气基线 |
| `outline` | text | brief | `text` | 故事结构 |
| `script` | text | outline, character-bible, voice-bible | `text` | 场次+对白+动作 |
| `shot-list` | text | script, style-bible | `text` | **表格化**镜头表 |
| `shot-prompt` | text | shot-list | `text` | 单镜头增量意图 |
| `mood-brief` | text | style-bible | `text` | BGM 情绪/节拍/时长 |
| `edit-plan` | note | 全部 clip+dub+bgm | `content` | 可交付剪辑时间轴 |
| `qc-report` | note | edit-plan | `content` | 验收报告 |

#### 资产 / 分镜 / 片段 / 音频层

| role | type | 父节点 | 关键 data |
|---|---|---|---|
| `character-sheet` | image | character-bible | `assetKind:'character'`, `characterRef`, `deltaIntent` |
| `scene-sheet` | image | scene-bible | `assetKind:'scene'` |
| `prop-sheet` | image | prop-bible | `assetKind:'prop'` |
| `keyframe` | image | shot-prompt, style-bible, character-sheet*, scene-sheet, prop-sheet* | `shotId`, `sceneId`, `characterRefs[]` |
| `shot-clip` | video | **keyframe**, shot-prompt, style-bible | `shotId`, `duration`, `size`, `transitionIn`, `poster` |
| `dub` | music | script, voice-bible | `dub:true`, `voice`, `voice_name`, `clone_audio`, `clone_voice_id` |
| `bgm` | music | mood-brief, style-bible | `duration`, `text` |
| `sfx` | music | shot-list | `text` |

### 3.3 通用 data 契约

| 字段 | 类型 | 说明 |
|---|---|---|
| `role` | string | 语义角色（本规范的核心扩展点） |
| `status` | `'pending'\|'running'\|'done'\|'error'` | **必填**，缺失时画布显示"无媒体" |
| `deltaIntent` | string | 本节点相对上游的**增量意图**——唯一真源 |
| `prompt` | string | **一次性编译产物**，刷新前由 `deltaIntent` 复制 |
| `shotId` / `sceneId` / `characterRefs` | string / string[] | 拓扑索引，供 Lint 校验 |
| `assetKind` | `'character'\|'scene'\|'prop'\|'conceptart'\|'reference'` | 决定落盘目录与素材库分类 |
| `errorMsg` | string | 失败原因（refresh 自动写入） |

### 3.4 边契约

`connect(from, to, label)` 中 `label` 写**依赖语义**（UI 不渲染，但 Lint 与语义字典依赖）：

| label | 语义 |
|---|---|
| `风格锚` | style-bible → 一切 image/video |
| `角色锚` / `场景锚` / `道具锚` | bible → sheet，sheet → keyframe |
| `声音锚` | voice-bible → dub |
| `首帧参考` | keyframe → shot-clip |
| `镜头意图` | shot-prompt → keyframe / shot-clip |
| `对白来源` | script → dub |
| `时长预算` | shot-list → shot-clip |
| `尾帧衔接` | keyframe(N) → keyframe(N+1) |

**入边完备性强制表**：

| 节点 role | 必需上游 role |
|---|---|
| `character-sheet` | `character-bible` |
| `scene-sheet` | `scene-bible` |
| `prop-sheet` | `prop-bible` |
| `keyframe` | `shot-prompt` + `style-bible` (+ 至少 1 张 sheet) |
| `shot-clip` | `keyframe` + `shot-prompt` + `style-bible` |
| `dub` | `voice-bible` + 台词来源（`script`） |
| `bgm` | `style-bible`（+ `mood-brief`） |

**唯一例外**：种子节点 `brief` 与 `capability-profile` 允许零入边。

### 3.5 Region 规范（8 区）

| id | label | kind | 承载 |
|---|---|---|---|
| `R-flow` | 流程总览 | `flow` | brief, capability-profile |
| `R-bible` | 一致性圣经 | `bible` | 五圣经 |
| `R-script` | 剧本文案 | `script` | outline, script, shot-list, shot-prompt |
| `R-assets` | 资产设定 | `characters` | character/scene/prop sheet |
| `R-board` | 分镜关键帧 | `storyboard` | keyframe |
| `R-clips` | 视频片段 | `media` | shot-clip |
| `R-audio` | 音频轨 | `audio` | dub, bgm, sfx |
| `R-final` | 成片与导出 | `final` | edit-plan, qc-report |

- 建区不传坐标 → 自动堆叠（默认 720×400）。
- `addNode` 带 `regionId` → 自动落宫格（列距/行距 300，内边距 24），超出自动扩容。
- 每阶段结束 `canvas_auto_arrange({ regionId })`（整理后自动 `fitRegion` 收拢）。

> 完整规范见 `references/topology-spec.md`。

---

## 四、父子驱动刷新契约（需求 2）

> 依据 `dsh-media-studio/src/tools.ts` 中 `buildRefreshContext` / `collectUpstreamImageUrls` / `executeNodeRefresh` 的**实际实现**编写。

### 4.1 契约总纲

> **除种子节点外，每个节点的内容都不是自己"想"出来的，而是由父节点编译出来的。**

```
final(child) = ConsistencyPrefix(祖先锚点) + UpstreamContext(父节点) + DeltaIntent(自身)
```

- 前两项由**上游节点经 `buildRefreshContext` 自动拼装**；第三项是 agent 写在 `data.deltaIntent` 的增量意图。
- **推论：下游节点永远不重复上游已经说过的话。** 上游改一个字，下游沿拓扑重刷即同步。

### 4.2 `buildRefreshContext` 的确切行为

对目标节点取**所有 `edge.target === nodeId`** 的 source，按边顺序拼成：

```
[<父节点 label>]: <父节点内容>
```

| 父节点 type | 取哪个字段 | 取不到时 |
|---|---|---|
| `text` / `note` | `data.text`，回退 `data.content` | `(no text content)` |
| `image` / `video` | `data.prompt` | `(no text content)` |
| `music` | `data.text` | `(no text content)` |

三个关键推论：
1. **只取一层直接上游，不递归** → 想让曾祖父级信息传到下游，**必须连边**（bible 通常直连到很远的下游）。
2. 空的文本节点会注入 `(no text content)` 噪声 → "建完立刻填内容"是硬纪律。
3. `image` 父节点传给子的是**它 refresh 后的完整 prompt**，所以定妆图的完整描述会注入关键帧 —— 这是好事。

### 4.3 按 type 的刷新公式

#### `image`（设定图 / 关键帧）

```
newPrompt = data.prompt
  ? `${data.prompt}\n\nContext from upstream nodes:\n${context}\n\nRegenerate the image keeping the original style and subject.`
  : `Generate an image that illustrates: ${context}`

generate_image({ prompt: newPrompt, model?, image?: upstreamImageUrls[] })
```

- **`data.prompt` 优先作主体**，上游上下文追加在后 → 增量意图写 `data.prompt`。
- 上游 `image` 节点带 `resultUrl` 时自动收集为 `image[]` → **自动 I2I**。
  - `http(s)://` / `data:` 直传；`file://` 与 `projects/...` → 读文件转 `data:image/...;base64`。
  - **只有 `type === 'image'` 的上游会被收集**（`video` 上游被忽略）。

#### `video`（视频片段）

```
upstream = collectUpstreamRefs(nodeId, graph, wsRoot)   // { images[], audios[] } —— 取所有第一层上游

generate_video({
  prompt:   newPrompt,                    // 同 image 的拼接逻辑
  duration: data.duration || 5,
  size:     data.size || '1280x720',
  model?,
  // 多图 I2V：首帧/尾帧按边标签识别，否则整组 reference 数组传入
  ...buildI2VArgs(upstream.images, data.videoMode)
})
```

- **取所有第一层上游媒体**（不只第一张）：`image` 节点 `resultUrl` + `video` 节点 `poster`（首帧）全部纳入，本地路径自动转 base64。顺序 = 边顺序，最重要参考放第一条边。
- **首帧 / 尾帧衔接**：上游图边标签为 `首帧参考`/`first-frame` → 首帧；`尾帧衔接`/`尾帧`/`last-frame` → 尾帧；两者都在 → `mode:'keyframes'` + `keyframes:[first,last]`（首尾帧驱动，杜绝生硬拼接）。无特殊标签但多图 → `mode:'reference'` 整组传入。
- `duration` / `size` 只从 `data` 取 → **每个 clip 都要显式写**。

#### `music`（配音 / BGM / 音效）

```
rawContext = buildRefreshContext(nodeId, graph, { labelPrefix: false })  // 原始文本，不带 [label]: 前缀
newPrompt = rawContext || data.prompt || '(no upstream text content)'    // ⚠️ 上游优先！
tool = (data.dub === true) ? 'generate_tts' : 'generate_music'
upstream = collectUpstreamRefs(nodeId, graph, wsRoot)                    // { images[], audios[] }

generate_tts  ({ text: newPrompt, voice?, clone_audio?, voice_name?, clone_voice_id? })
generate_music({ text: newPrompt, voice? })
```

- **与 image/video 相反：上游文本优先于 `data.prompt`**，且用**原始文本**（去掉 `[label]:` 前缀）—— 否则 TTS 会念出 "**[剧本]：我还是来晚了**"。
- `voice` / `voice_name` / `clone_audio` / `clone_voice_id` 透传给 TTS → 同角色必须全程同值。
- **音色继承（clone-audio inheritance）**：`dub` 节点有上游 `music` 节点且自身未显式给 `clone_audio` 时，自动把上游音频当 `clone_audio`（克隆种子），并用 `data.characterRef`/`data.voice_name` 派生稳定 `voice_name`。先克隆出一个参考声音节点，后续对白自动复用同一音色，无需逐节点手填。

### 4.4 写回策略：刷新是**严格单向**的

刷新成功后的 `updateNode` **只写当前节点，永不回写上游**：

```js
data.status     = 'done'
data.resultUrl  = <本地落盘路径>
data.lastPrompt = <编译后的完整 newPrompt>   // 审计轨迹，不覆盖作者意图
data.text       = <newPrompt>                // 仅 music 节点（卡片展示）
// data.prompt 保持不变（作者意图 = 真源）
```

- `data.prompt` 是**作者意图真源**，刷新**永不修改**；编译产物落到 `data.lastPrompt` 仅供审计。
- **禁止反向更新上游**：生成结果与上游 prompt 不一致时，通过"改上游源 → 单向重刷下游"修正，不从子节点回填。这是画布一致性的根基。
- 因此**不再需要**"每次刷新前把 `data.prompt` 重置为 `deltaIntent`"的旧规程，可直接重复刷新。

### 4.5 增量重生成传播

```
改了上游 U
  → 前向可达遍历（沿边方向）得受影响集合 D
  → 按拓扑序排序
  → 对 D 中每个媒体节点：直接 canvas_refresh_node（data.prompt 为作者意图真源，无需每次重置）
  → SSE 实时回灌，用户看到逐张卡片转圈→完成
  → 跑一次 lint_canvas.py
```

**不要全片重刷**：成本高，且会重新引入随机漂移。只刷脏节点。

### 4.6 反模式清单

| 反模式 | 后果 | 正确做法 |
|---|---|---|
| 下游 `prompt` 抄了一遍角色设定 | 上游改了下游不变 | 下游只写增量，靠边连 bible |
| 角色图/场景图/道具图不连进 clip | I2V 只拿关键帧，多图参考丢弃 | 同镜所有 image 上游都连进 clip（自动多图 I2V/reference） |
| 想首尾帧衔接却不打 `首帧参考`/`尾帧衔接` 标签 | 成片像硬切 | 关键帧边打 `首帧参考`，上镜尾帧边打 `尾帧衔接` |
| 配音台词写在 `dub.data.prompt` | 有上游时被忽略，且 TTS 念出 `[剧本]:` 前缀 | 台词放上游 `text` 节点（rawContext 自动去前缀） |
| 每个 dub 都手填 `clone_audio` | 易错、音色不一致 | 先克隆参考声音节点，后续 dub 自动继承 |
| 从子节点回填上游内容 | 拓扑腐化、无法溯源 | 改上游源 → 单向重刷下游 |
| 只连 `shot-list` 不连 `shot-prompt` | 每镜拿到全表，互相污染 | 一镜一个 `shot-prompt` |
| 建了 text 节点没填内容 | 注入 `(no text content)` | 同批 `updateNode` 填内容 |

> 完整规范见 `references/refresh-contract.md`。

---

## 五、工程化方法论（需求 3）

### 5.1 核心映射：视频工程 ≈ 软件工程

| 软件工程 | 视频创作工程 | 画布载体 |
|---|---|---|
| 源码（source） | 圣经 + 剧本 + 镜头表 | `R-bible` / `R-script` 的 `text` 节点 |
| 依赖图 / import | 画布 edge（`connect(from,to,label)`） | `edges[]` |
| 中间产物 | 设定图 → 关键帧 | `R-assets` / `R-board` |
| 构建产物 | 视频片段 + 音频 | `R-clips` / `R-audio` |
| 编译器 | `canvas_refresh_node` | 工具 |
| **增量编译** | 脏标记 + 只重刷受影响下游 | Refresh Orchestrator |
| Lint / 类型检查 | `scripts/lint_canvas.py` | 脚本 |
| 包管理 / 依赖复用 | 项目素材库 + 跨项目软引用 | `media_studio_*` |
| 版本号 | 画布 `version`（每次 patch 自增） | `CanvasStore` |
| CI / 门禁 | 阶段末 lint + Phase 9 验收 | Gate |
| 构建配置 | `brief`（画幅/时长/调性）+ `capability-profile` | `R-flow` |

### 5.2 "Superpower" 框架的四条工程原则

**① 单一真源（Single Source of Truth）**
每个事实只在**一个节点**里定义一次，其它地方通过边引用。
- 角色外貌只在 `character-bible` + `character-sheet` 定义。
- 画风只在 `style-bible` 定义。
- 音色只在 `voice-bible` 定义。

**② 增量意图（Delta Intent）**
每个节点只声明**相对上游的差异**，不重复上游。
```
❌ S03 prompt: "林晚，28岁，黑发齐肩，深棕瞳，穿米白开衫，在咖啡馆推门，电影感，35mm..."
✅ S03 deltaIntent: "林晚推开木门，风铃轻响，顿住半秒，目光看画右窗边。缓慢 push in 15%。"
   （角色/场景/风格由父节点注入）
```

**③ 可重编译（Reproducible Rebuild）**
任何时刻都能从"源码"重建任意节点：
- 保留 `data.deltaIntent` → 可安全重复刷新。
- 拓扑完整 → 可定位任一节点的全部依赖。
- 资产入库 → 可跨项目复用。

**④ 门禁前置（Shift-Left Gating）**
问题在**设计阶段**发现，而不是在成片后返工：
- 一致性在 bible + 边结构设计阶段保证（Lint 强制入边）。
- 连贯性在 `shot-list` 阶段设计（180°/30°/转场/时长预算）。
- 每阶段末跑 lint，ERROR 不过不放行。

### 5.3 分层编译模型

```
Layer 0  源码层    brief → bibles → outline → script → shot-list → shot-prompt
                   （纯文本，零生成成本，可反复修改，是全部一致性的真源）
   ↓ 编译
Layer 1  资产层    character-sheet / scene-sheet / prop-sheet
                   （低频生成，一次生成全片复用；入库后可跨项目软引用）
   ↓ 编译
Layer 2  分镜层    keyframe × N
                   （每个镜头一张；I2I 继承资产层图锚）
   ↓ 编译
Layer 3  片段层    shot-clip × N
                   （I2V 首帧 = Layer 2 关键帧；这是一致性的最关键一环）
   ↓ 编译
Layer 4  音频层    dub × N / bgm / sfx
                   （台词来自 Layer 0，音色来自 voice-bible）
   ↓ 编译
Layer 5  交付层    edit-plan（时间轴）+ qc-report（验收）
```

**关键**：每一层的修改只影响它下面的层。改 `brief` → 全部重编译；改 `shot-prompt` → 只重编译该镜的 Layer 2/3/4。

---

## 六、一致性保障方案（需求 4）

### 6.1 四锚点模型

| 锚 | 载体 | 注入机制 | 保障维度 |
|---|---|---|---|
| **风格锚** | `style-bible`（text）+ `风格锚` 边 | 文本进 `buildRefreshContext` | 画风/色彩/焦段/画幅/负面约束 |
| **图锚** | `character-sheet`/`scene-sheet`/`prop-sheet` | `collectUpstreamImageUrls` → I2I/I2V | 外貌/场景/产品**像素级**一致 |
| **文锚** | `character-bible`/`scene-bible`/`prop-bible` | 文本进 context | 语义级细节补充 |
| **声锚** | `voice-bible` + `data.voice*` | TTS 参数恒定 | 音色/语速/语气 |

> **图锚优先于文锚。** 文本会被模型"自由发挥"，参考图不会。凡是能用图锚的地方（角色/场景/道具）**必须同时提供图锚 + 文锚**。

### 6.2 各维度保障细则

#### 角色一致性（最高优先级）

- **角色 ID 稳定**：`CHAR_<拼音大写>`，全片唯一，禁止改名。
- **定妆图唯一**：同一角色全片只维护**一张主 `character-sheet`**（正面半身 + 平视 + 中性表情 + 纯色背景）。换装需新建节点并在 `shot-list` 标注。
- **镜头级强制**：每个出现该角色的 `keyframe`/`shot-clip`，入边必须包含 `character-sheet`（图锚）+ `character-bible`（文锚）+ `style-bible`（风格锚）。
- **跨项目复用**：生成新角色前先 `media_studio_search_assets` 查已有资产 —— **重新生成 = 引入一张新脸**。

#### 场景一致性

- 每场景一张 `scene-sheet`（establishing shot 视角 + 该场景主光）。
- 同场景所有 `keyframe` 连同一张 sheet。
- **同场景不同时段各出一张**（晨/昏/夜），避免"夜戏比日戏亮"。

#### 道具 / 产品一致性（广告片生命线）

- `prop-bible` 写成**产品规格书**：外形、材质、颜色、比例、logo 位置、包装。
- `prop-sheet` 生成**至少 3 张**：正面 / 45° / 特写（单一视角在极端机位下会漂移）。
- 广告片铁律：**产品外观零容忍偏移**。变形必须重生成，不接受"差不多"。

#### 配音一致性

- `voice-bible` 为每个角色 ID 定义 `voice` / 语速 / 语气 / 口头禅。
- 每个 `dub` 固定写同一组 `voice` / `voice_name` / `clone_voice_id`。
- 有克隆：**每角色只克隆一次**，`voice_name` 存进 `voice-bible` 复用。
- 无克隆：固定 `voice` 名 + 台词前缀 `[角色语气：克制、语速慢]`。
- **同一角色的所有台词在同一批次连续生成**，减少服务商侧随机性。

### 6.3 一致性 Lint（`scripts/lint_canvas.py` 已实现）

| 级别 | 规则 |
|---|---|
| ERROR | `keyframe`/`shot-clip` 缺 `style-bible` 入边 |
| ERROR | `shot-clip` 未连 `keyframe`（无 I2V 首帧） |
| ERROR | `shot-clip` 的第一个 image 上游不是 `keyframe`（I2V 取错图） |
| ERROR | 声明了 `characterRefs` 但未连任何 `character-sheet` |
| ERROR | `dub` 缺 `voice-bible` 或台词来源 |
| ERROR | 同一 `shotId` 多个 `keyframe`/`shot-clip` 且未标 `take` |
| ERROR | 存在 `status:'error'` 的媒体节点 |
| ERROR | `text`/`note` 节点内容为空 |
| ERROR | 媒体节点无入边（孤立节点） |
| WARN | 全片 `data.size` 不一致 |
| WARN | `sum(duration)` 与 brief 预算偏差 > 10% |
| WARN | 媒体节点缺 `data.deltaIntent` |
| WARN | `prompt != deltaIntent` 且已 `done`（疑似重复刷新未重置） |
| WARN | `shot-clip` 未标 `transitionIn` |
| WARN | sheet 未入库素材库 |
| INFO | 连续 3 个以上运动镜头 |

### 6.4 一致性事故处置表

| 症状 | 根因 | 处置 |
|---|---|---|
| 角色脸变了 | 该镜 keyframe 没连 character-sheet，或参考图入边顺序靠后 | 补边 + 重置 prompt + 重刷 keyframe 与 clip |
| 服装变了 | bible 未写服装 / 太笼统 | 补全 bible → 重刷 sheet → 传播下游 |
| 场景色调跳 | 未连 scene-sheet | 补边 → 重刷 |
| 产品变形 | 参考图视角与机位差异过大 | 补该机位产品参考图 → 重刷 |
| 风格忽写实忽动画 | style-bible 未直连该节点 | 补 `风格锚` 直连边 |
| 配音不像同一人 | 不同镜用了不同 `voice` | 统一为 voice-bible 登记值 → 重生成全部 dub |
| 越刷越离谱 | 重复 refresh 未重置 `data.prompt` | 重置 `prompt = deltaIntent` 后重刷 |

> 完整方案见 `references/consistency-playbook.md`。

---

## 七、衔接连贯性方案（需求 5）

> 核心思路：**连贯性在 `shot-list` 阶段就设计好，不在剪辑阶段补救。**

### 7.1 时间轴预算

1. `brief` 锁定总时长 `T` 与画幅。
2. `shot-list` 每镜显式给时长，**`sum(时长) == T`**。
3. 预留片头 hook 1–2s、片尾 CTA 1–2s（广告必留）。
4. `shot-clip.data.duration` 逐镜照抄，不允许片段阶段改。
5. Lint：`|sum(duration) - T|/T > 10%` → WARN。

### 7.2 镜头语言规范

**景别**：`ELS` 大远景 / `LS` 远景 / `MS` 中景 / `MCU` 中近景 / `CU` 特写 / `ECU` 大特写
**运动**：`static` / `push in` / `pull out` / `pan` / `tilt` / `track` / `dolly` / `handheld` / `crane` / `orbit`

**六条硬规则**：

| 规则 | 说明 |
|---|---|
| **180° 轴线** | 同一对话场景机位保持轴线同侧；越轴须标注并插入中性镜过渡 |
| **30° 规则** | 同一主体连续两镜机位角差 ≥ 30°，否则跳切 |
| **景别递进** | 段落内 ELS→LS→MS→MCU→CU 递进或反向，不随机跳 |
| **动静交替** | 固定镜与运动镜交替 |
| **视线匹配** | A 看向画右 → B 必看向画左（写进 `shot-prompt`） |
| **动作重叠** | 跨镜动作重叠 20–30%（写进 `edit-plan` 出入点） |

### 7.3 转场设计（`data.transitionIn`）

| 转场 | 适用 |
|---|---|
| `cut` | **默认**，最安全 |
| `match-cut` | 形状/动作相似的两镜（靠 `keyframe` 构图对齐） |
| `cross-dissolve` | 时间流逝、回忆（1–1.5s） |
| `whip-pan` | 快速场景切换（需上一镜结尾带快速摇镜） |
| `fade-in/out` | 仅用于大段落起止 |
| `J-cut` | **对白先入**（音频提前 0.5–1s） |
| `L-cut` | **对白延续**（音频延后 0.5–1s） |

> 叙事类内容滥用花哨转场是廉价感的主要来源。默认 `cut`。

### 7.4 首尾帧链（视觉连续性）

`collectUpstreamImageUrls` **只收集 `type==='image'` 的上游**，所以视频片段不能直接把上一片段当首帧参考。三种可行做法：

1. **共享关键帧锚（推荐，零工具依赖）**
   `keyframe(N+1)` 除自己的 `shot-prompt` 外，再连一条 `尾帧衔接` 边到 `keyframe(N)` → 两张关键帧走 I2I，保证环境光/色调/构图延续。

2. **尾帧提取（需本地 ffmpeg）**
   ```bash
   ffmpeg -sseof -0.1 -i clip_S03.mp4 -frames:v 1 -q:v 2 tail_S03.jpg
   ```
   用 `batchAddMedia` 加成 `tail-frame` 节点，作为 `keyframe(S04)` 的图锚 —— **最强的首尾帧对齐**。

3. **同场景关键帧复用**：同场景连续镜头全部连同一张 `scene-sheet`，天然背景一致。

### 7.5 对白衔接

| 手法 | 做法 |
|---|---|
| J-cut | `edit-plan` 标注 `音频入点 = 视频入点 - 0.8s` |
| L-cut | 标注 `音频出点 = 视频出点 + 0.8s` |
| 对白重叠 | 打断场景给出两轨交叉电平曲线 |
| 语气延续 | `voice-bible` 写清情绪转折处的语气变化 |
| 静默留白 | 关键情绪点前后留 0.5s 静音（比填满音频更有力） |

### 7.6 背景音衔接

| 方案 | 适用 | 做法 |
|---|---|---|
| **单曲贯穿**（推荐） | 短剧/微电影 | 1 个 `bgm`，`duration = 总时长`；标注淡入淡出与 ducking 曲线 |
| **分段拼接** | 创意视频 | 多段 bgm，交叉淡入淡出 1–2s，BPM 对齐切点 |
| **节拍先行** | 创意/广告 | 先定 BGM 与 BPM，再反推镜头时长（整拍数），切点落鼓点 |

- 电平：`dub` 0dB，BGM 在对白段降到 -12 ~ -18dB（ducking）。
- 段落交界 BGM 必须淡出到 -inf 再淡入，**不硬切**。

### 7.7 `edit-plan` 输出结构

```
# 剪辑时间轴 · <片名> · 总时长 30.0s · 1920x1080
## 视频轨 V1   | # | 镜头 | 节点 | 入点 | 出点 | 时长 | 转场入 |
## 音频轨 A1（对白） | # | 节点 | 入点 | 出点 | 电平 | 备注(J/L-cut) |
## 音频轨 A2（BGM） 淡入 / ducking / 淡出 时间码
## 音频轨 A3（SFX） 与画面动作点对齐
## 字幕轨
## 一致性备注（产品参考 / 定妆图）
```

### 7.8 生硬拼接的成因与解药

| 症状 | 成因 | 解药 |
|---|---|---|
| 两镜之间"跳" | 越轴 / 违反 30° 规则 | 回 `shot-list` 改机位描述，重刷关键帧 |
| 人物位置对不上 | 视线方向未写进 prompt | `shot-prompt` 显式写"看向画右" |
| 背景忽明忽暗 | 未共用 scene-sheet | 补场景图锚 |
| 声音突然断 | BGM 硬切 / 无 J-cut | `edit-plan` 补淡入淡出与 J/L-cut |
| 节奏拖沓 | 镜头时长与 BGM 拍点无关 | 按 BPM 重排时长或换 BGM |
| 结尾草率 | 无 CTA / 无收束镜 | 补片尾镜与字幕轨 |

> 完整方案见 `references/continuity-playbook.md`。

---

## 八、工具与能力自动发现（需求 6）

### 8.1 能力矩阵

| 能力码 | 含义 | 提供者 |
|---|---|---|
| `CANVAS` | 画布能力 | `canvas_*` / `media_studio_*` |
| `IMAGE` | 文生图 | `generate_image` |
| `I2I` | 图生图（上游 image 自动注入） | `generate_image` + 边 |
| `VIDEO_T2V` | 文生视频 | `generate_video` |
| `VIDEO_I2V` | 图生视频（首帧参考） | `generate_video` + 边 |
| `TTS` | 文本转语音 | `generate_tts` |
| `TTS_CLONE` | 声音克隆 | `generate_tts` + `voice_name`/`clone_audio` |
| `MUSIC` | BGM/音效 | `generate_music` |

### 8.2 三级探测策略（代价递增）

**① 静态探测（首选，零成本）**
检查当前会话工具注册表中是否含 `generate_image/video/tts/music`。能列出工具名 → 直接填矩阵。

**② 低成本试探（静态不可用时）**
最小代价调用一次确认存在：
```
generate_image({ prompt: "a plain gray square", size: "512x512" })
```
**只做一次**，结果记入 `capability-profile`。

**③ 惰性探测（默认推荐）**
直接开工，首次真实调用结果即探测结果。失败时立即切降级并告知用户。
> 对长流程最省时，但**必须在第一次调用失败时立即切换**。

**高阶能力只能实测确认**：

| 能力 | 确认方式 |
|---|---|
| `I2I` / `VIDEO_I2V` | 建 `image→image`（或 `image→video`）边后 refresh，观察结果是否贴合参考图 |
| `TTS_CLONE` | 试传 `voice_name` + `clone_audio`，被忽略/报错即不支持 |
| `duration` 上限 | 试 `duration:10`，超限会报错或截断 |
| `size` 支持 | 试目标画幅（如 `720x1280`），不支持则回落 `1280x720` 后期裁切 |

**结果落盘**：写入 `R-flow` 区的 `capability-profile`（`note` 节点），后续决策引用它；能力变化或持续报错时重探并更新。

### 8.3 降级矩阵

| 缺失能力 | 影响 | 降级方案 | 告知用户 |
|---|---|---|---|
| `CANVAS` | 全盘不可用 | 停止，指引安装 `dsh-media-studio` 并启动 `dsh web` | 阻断 |
| `IMAGE` | 无图 | 停止媒体层；交付 brief+圣经+剧本+镜头表（文本交付物仍完整） | 阻断 |
| `VIDEO_T2V` | 无视频 | **动态漫剧模式**：关键帧序列 + `edit-plan`（Ken Burns/推拉/转场/时长） | 降级 |
| `VIDEO_I2V`（有 T2V） | 一致性骤降 | 强化首帧文字描述 + 风格硬约束；一致性 Lint 提级为 ERROR | 降级 |
| `I2I` | 资产复用困难 | 全靠 `character-bible` 文字锚（写成"可再生成的完整外貌规格"） | 降级 |
| `TTS` | 无配音 | 出口播稿 `text` + 字幕轨，`edit-plan` 标"待人工配音" | 降级 |
| `TTS_CLONE` | 音色漂移 | 固定 `voice` 名 + 台词加角色语气前缀；同角色同批生成 | 提示 |
| `MUSIC` | 无 BGM | `bgm` 占位 + `mood-brief` 写推荐曲风/BPM，`edit-plan` 标"待配乐" | 降级 |
| 画幅不支持 | 构图错误 | 用最近支持画幅生成，`edit-plan` 标注裁切/加边方案 | 提示 |

### 8.4 运行期失效处理

1. 解析错误码：`multimodal-failed` / `multimodal-threw`（服务商侧）· `no-prompt`（本技能侧）· `node-not-found`（id 写错）。
2. 限流 → 指数退避重试 ≤3 次；持续失败 → 更新 `capability-profile` 并走降级。
3. 已标记可用的能力开始持续失败 → **重跑探测**，更新矩阵后再继续。
4. 失效与处置写进 `qc-report`。

### 8.5 资源发现（能力之外的"已有素材发现"）

生成新资产前**先查素材库**，避免重复生成引入不一致：
```
media_studio_search_assets({ q: "<角色名或场景关键词>" })
```
- 命中本项目已有 sheet → **直接复用，不要重新生成**（重新生成 = 新的一张脸）。
- 命中其他项目资产 → `addSoftRef: true` 软引用进当前画布（不复制文件）→ **跨项目一致性**。
- 续做已有画布时先 `canvas_graph_view` 判断断点，从断点继续，**不推倒重来**。

> 完整方案见 `references/tool-discovery.md`。

---

## 九、内容类型模板

| 类型 | 时长 | 镜头/格数 | 画幅 | 一致性侧重 | 关键差异 |
|---|---|---|---|---|---|
| **短剧** | 60–180s/集 | 8–15 镜，3–5s/镜 | 9:16 竖屏 | ⭐⭐⭐⭐⭐ 角色 | 前 3s 必有 hook；dub 最多；跨集复用定妆图 |
| **微电影** | 3–8 min | 20–40 镜，5–10s/镜 | 16:9 | ⭐⭐⭐⭐ 场景+光影 | 长镜头/留白；BGM 主导；同场景不同时段各出 scene-sheet |
| **创意视频** | 15–60s | 6–12 镜，1–5s/镜 | 1:1 / 9:16 | ⭐⭐⭐ 风格 | **BGM 先行**，按 BPM 反推镜头时长；转场丰富 |
| **商品广告** | 15–30s | 5–8 镜，2–5s/镜 | 随投放位 | ⭐⭐⭐⭐⭐ 产品 | prop-bible 写规格书；产品图 ≥3 视角；CTA 1.5–2s；字幕必备 |
| **AI 漫剧** | 30–120s/集 | 10–25 格 | 9:16 竖屏 | ⭐⭐⭐⭐⭐ 画风+角色 | 分格叙事；拟声词/旁白独立节点；**禁止模型画文字**（气泡后期合成） |

**Region 权重差异**：

| Region | 短剧 | 微电影 | 创意 | 广告 | 漫剧 |
|---|---|---|---|---|---|
| R-bible | 角色重 | 场景重 | 风格重 | 道具重 | 风格+角色重 |
| R-assets | 中 | 中 | 轻 | **最重** | 中 |
| R-board | 中 | 重 | 中 | 中 | **最重** |
| R-clips | 重 | 重 | 中 | 中 | 轻（部分格动效） |
| R-audio | **最重**（对白） | 中（BGM） | **最重**（BGM） | 重（口播） | 重（旁白+拟声） |

> 详见 `references/content-templates.md`。

---

## 十、九阶段工作流

| Phase | 名称 | 关键动作 | 出口条件 |
|---|---|---|---|
| 0 | 能力探测 | 三级探测 → 能力矩阵 → `capability-profile` 节点 | 矩阵完整，缺失已定降级 |
| 1 | 立项与骨架 | create/open project → 8 Region → `brief` | brief 含时长/画幅/调性 |
| 2 | 编写圣经 | 5 个 bible 节点，全部以 brief 为父 | 五圣经内容完整 |
| 3 | 剧本与镜头表 | outline → script → shot-list → shot-prompt × N | `sum(时长)==T` |
| 4 | 资产设定图 | character/scene/prop sheet，入库 | 每张 sheet 已注册资产 |
| 5 | 分镜关键帧 | keyframe × N，连 sheet + style-bible + shot-prompt | 每帧入边完备 |
| 6 | 视频片段 | shot-clip × N，I2V 首帧 = keyframe | 每片 status=done |
| 7 | 音频 | dub（上游台词）+ bgm + sfx | 音色与 voice-bible 一致 |
| 8 | 合成指令 | `edit-plan` 时间轴 | 含视频轨/对白轨/BGM轨/字幕轨 |
| 9 | 验收门禁 | `lint_canvas.py` → 修 ERROR → `qc-report` | ERROR = 0 |

### 七条画布写入纪律

1. **非种子节点必须有入边** —— `addNode` 与 `connect` 同批。
2. **建 `text`/`note` 后立刻 `updateNode` 填内容**。
3. **`data.deltaIntent` 是真源，`data.prompt` 是编译产物** —— 刷新前必须重置。
4. **单批 ≤ 60 op**，一次 patch 完成一个阶段。
5. **每阶段结束 `canvas_auto_arrange({ regionId })`**（用户在实时看）。
6. **画幅与时长在 `shot-list` 阶段锁死**。
7. **`data.status` 必填** `done`/`running`/`error`。

---

## 十一、交付物清单与验收

### 11.1 文件结构（已实例化）

```
~/.workbuddy/skills/media-studio-video-director/
├── SKILL.md                              # 主入口：定位、心智模型、9 阶段流程、7 条纪律
├── references/
│   ├── topology-spec.md                  # 节点拓扑规范（角色字典 / data 契约 / 边契约 / Region）
│   ├── refresh-contract.md               # 父子刷新契约（对齐 tools.ts 源码行为）
│   ├── consistency-playbook.md           # 四锚点模型 + Lint 规则 + 事故处置
│   ├── continuity-playbook.md            # 镜头语言 / 转场 / 对白 / BGM / edit-plan 模板
│   ├── content-templates.md              # 5 类内容模板 + Region 权重
│   └── tool-discovery.md                 # 能力矩阵 / 三级探测 / 降级矩阵
├── assets/
│   └── prompt-templates.md               # 圣经 / 镜头 / 音频 提示词片段库
└── scripts/
    └── lint_canvas.py                    # 一致性 + 连贯性 Lint（15 组规则）
```

本设计文档：`docs/SKILL-DESIGN-media-studio-video-director.zh.md`

### 11.2 已完成的自检

| 项 | 结果 |
|---|---|
| `lint_canvas.py` 正常画布（13 节点/16 边） | ✅ ERROR 0，退出码 0 |
| `lint_canvas.py` 破坏画布（缺锚/孤立/空节点/error 状态/画幅不一致） | ✅ 捕获 7 ERROR + 5 WARN，退出码 1 |
| `--json` 机器可读输出 | ✅ |
| `--api` 直连运行中的 DSH 拉取实时画布 | ✅ 已实现（待联调） |
| SKILL.md frontmatter 含 `agent_created: true` | ✅ |

### 11.3 落地依赖（无需改代码）

全部能力通过**现有工具 + `data` 扩展字段**实现，对 `dsh-media-studio` **零代码改动**：

| 依赖 | 现有实现 |
|---|---|
| 节点语义扩展 | `data.role` / `data.deltaIntent` 等自由字段 |
| 父→子上下文注入 | `buildRefreshContext`（已实现） |
| 图锚 I2I / I2V | `collectUpstreamImageUrls`（已实现） |
| 配音走 TTS | `data.dub === true` → `generate_tts`（已实现） |
| 声音克隆 | `voice_name` / `clone_audio` 透传（已实现） |
| 资产入库与跨项目复用 | `media_studio_register_asset` / `search_assets` 软引用（已实现） |
| 分区与自动布局 | `addRegion` / `regionId` / `canvas_auto_arrange`（已实现） |
| 实时可视化 | SSE `canvas-patch`（已实现） |

### 11.4 演进路线

| 阶段 | 目标 |
|---|---|
| **M1（当前）** | 规程层：本技能 + Lint 脚本，零代码改动 |
| **M2** | `canvas_pipeline_init` 工具：一键按模板生成整套 Region+Node+Edge 骨架（省去逐条 op） |
| **M3** | 画布侧原生支持 `data.role` 语义着色 / 角色筛选视图 / 脏标记传播 UI |
| **M4** | `canvas_refresh_node` 支持 `resetPromptFrom: 'deltaIntent'` 参数，从机制上消除 prompt 膨胀 |
| **M5** | 尾帧提取内置（`video-cover.ts` 已有 ffmpeg 能力），原生支持首尾帧链 |
| **M6** | 一致性自动评分：对同角色的多张关键帧做相似度比对，量化一致性 |

---

## 附录 A：需求覆盖对照

| 需求 | 落地章节 | 实现载体 |
|---|---|---|
| 1. 拓扑图展示创作流程与生成内容 | 三、3.1–3.5 | Region 8 区 + 16 种 role + 边契约 |
| 2. 除初始节点外，每节点由父类节点引导刷新 | 四、4.1–4.5 | 父子刷新契约 + deltaIntent 规程 |
| 3. 视频创作工程化（类 superpower 框架） | 五、5.1–5.3 | 源码→资产→分镜→片段→音频→交付 六层编译 |
| 4. 角色/场景/道具/配音一致性 | 六、6.1–6.4 | 四锚点模型 + Lint + 事故处置表 |
| 5. 片段内容与音画衔接连贯 | 七、7.1–7.8 | 镜头语言六规则 + 转场表 + J/L-cut + BPM + 首尾帧链 |
| 6. 自动发现可用工具与技能 | 八、8.1–8.5 | 能力矩阵 + 三级探测 + 降级矩阵 + 素材发现 |
| 覆盖多种视频内容类型 | 九 | 5 类模板 + Region 权重差异 |

## 附录 B：核心创新点

1. **`data.role` 语义层** —— 在只有 5 种节点类型的画布上，用 `data` 扩展字段承载 16 种语义角色与完整工程语义，**零代码改动**获得工作流能力。
2. **"圣经节点 + 强制入边"实现一致性** —— 把"模型要记住设定"转化为"拓扑强制模型看到设定"，把概率问题变成结构问题。
3. **deltaIntent / prompt 分离** —— 发现并规避 `canvas_refresh_node` 覆写 `data.prompt` 导致的二次刷新劣化，是可重复重编译的前提。
4. **双锚点（图锚 + 文锚）** —— 图锚走 `collectUpstreamImageUrls` 自动 I2I/I2V，文锚走 `buildRefreshContext` 自动注入，两者互补。
5. **能力探测前置 + 明确降级** —— 缺能力不失败，而是切换到可交付的替代方案并明确告知，保证任何环境下都有产出。

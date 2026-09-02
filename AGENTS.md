# dsh-media-studio — Agent Usage Guide

## Overview

`dsh-media-studio` 是一个 DeepSeek Harness 插件，为 AI agent 提供**无限画布（infinite canvas）** + **多模态内容生成**能力。Agent 通过 6 个工具在画布上编排文本、图片、视频、音乐的生成管线，用户可以在 DSH Web GUI 的画布 tab 中实时查看管线进展。

## 已注册工具

| 工具名 | 作用 |
|---|---|
| `generate_text` | 调用 DSH 配置的 LLM 生成文本（支持任意 provider） |
| `generate_image` | 调用 mediaStudio.image provider 生图（默认 Agnes） |
| `generate_video` | 调用 mediaStudio.video provider 生成短视频（默认 Agnes） |
| `generate_music` | 调用 mediaStudio.music provider 生成语音/TTS（默认 MiniMax） |
| `canvas_graph_view` | 读取当前画布快照（nodes + edges + version） |
| `canvas_graph_patch` | **原子批量写画布**（推荐：一次调用完成整个管线） |

## 典型工作流

### 单步生成 + 落画布

```
1. 调用 generate_image / generate_video / generate_music
2. 拿到 { ok: true, url, model, latencyMs } 结果
3. 调用 canvas_graph_patch，用 batchAddMedia 将结果写入画布
4. 可选：调用 canvas_graph_view 确认状态
```

### 完整管线（推荐：单次 patch）

agent 应在**同一个 `canvas_graph_patch` 调用**里完成多个节点和边的创建，避免多次往返导致部分结果丢失：

```jsonc
// 示例：生成一张图 → 基于图生成视频 → 为视频配音
{
  "canvasId": "main",
  "ops": [
    {
      "op": "batchAddMedia",
      "items": [
        { "kind": "image", "url": "<img-url>", "prompt": "一只猫坐在月亮上" }
      ]
    },
    {
      "op": "connect",
      "from": "<image-node-id>",
      "to": "<video-node-id>"
    },
    {
      "op": "batchAddMedia",
      "items": [
        { "kind": "video", "url": "<video-url>", "prompt": "猫仰望星空" },
        { "kind": "audio", "url": "<audio-url>", "prompt": "旁白：夜晚的宁静" }
      ]
    }
  ]
}
```

**注意**：上例中的 node id 需要从上一个 `batchAddMedia` 的返回结果中获取（工具返回中不直接包含生成的 id）。实践中建议先 `canvas_graph_view` 拿到当前最大 id，再构造下一个节点的 `nodeId` 字段以保持一致性——或者依赖服务端的自动 id 生成，在 view 结果中匹配最新加入的节点。

### 含文本的管线

```
1. generate_text → 得到文案/剧本
2. 用 canvas_graph_patch 添加 text 节点记录文案
3. 基于文案调用 generate_image / generate_video / generate_music
4. 用 batchAddMedia + connect 把各媒体节点串起来
```

## 工具详解

### `generate_text`

```typescript
parameters: {
  prompt: string,          // 必填：用户提示词
  model?: string,          // 可选："<provider>/<model>" 覆盖默认
  system?: string,         // 可选：system prompt
}
output: {
  text: string,            // 生成文本
  model: string,
  usage: { inputTokens, outputTokens },
  latencyMs: number,
}
```

文本结果可以作为后续图像的 prompt、视频描述或 TTS 文本。

### `generate_image`

```typescript
parameters: {
  prompt: string,          // 必填
  model?: string,          // 可选覆盖默认
  aspectRatio?: '1:1' | '16:9' | '9:16' | '4:3' | '3:4',
  refImageUrls?: string[], // 图生图参考图（可选）
}
output: {
  ok: true, url: string, model: string, bytes: number, latencyMs: number, kind: 'image'
} | { ok: false, code: string, message: string, kind: 'image' }
```

图片下载到本地后返回 `file://...` 路径，可直接在画布渲染。

### `generate_video`

```typescript
parameters: {
  prompt: string,
  model?: string,
  aspectRatio?: '16:9' | '9:16' | '1:1' | '4:3' | '3:4',
  durationS?: number,      // 4-12 秒整数，多数 provider 限制
  refImageUrls?: string[], // 首帧参考（图生视频）
}
output: { ok, url, model, bytes, latencyMs, kind: 'video' }
```

视频生成是 submit + poll 模式，可能阻塞 **30–90 秒**。调用时传入 `exec.signal` 以支持取消。

### `generate_music`

```typescript
parameters: {
  text: string,            // 必填：TTS 朗读文本（非歌词）
  voice?: string,          // 可选：voice preset id
  speed?: number,          // 0.5–2.0，默认 1.0
}
output: { ok, url, model, bytes, latencyMs, voice, kind: 'audio' }
```

### `canvas_graph_view`

```typescript
parameters: {
  canvasId?: string,       // 可选，默认 'main'
}
output: {
  graph: { nodes, edges },
  version: number,
}
```

**最佳实践**：在执行 `canvas_graph_patch` 前调用此工具确认当前画布状态，避免基于过时版本做决策。

### `canvas_graph_patch`

```typescript
parameters: {
  canvasId?: string,       // 可选，默认 'main'
  ops: CanvasOp[],         // 必填，最多 60 个 op
}
output: {
  applied: number,
  version: number,
  lintOk: boolean,
  issues: string[],        // 警告/错误列表
}
```

支持的 op 类型：

| op | 参数 | 说明 |
|---|---|---|
| `addNode` | `{ type, label, data?, position?, nodeId? }` | 添加节点；position 缺省时自动放入空闲网格位；nodeId 可让同批后续 op（如 connect）引用该节点 |
| `updateNode` | `{ id, data }` | 更新节点数据 |
| `renameNode` | `{ id, label }` | 重命名节点 |
| `deleteNode` | `{ id }` | 删除节点（连带边） |
| `moveNode` | `{ id, position }` | 移动节点位置 |
| `connect` | `{ from, to, branch? }` | 连接两个节点 |
| `deleteEdge` | `{ id }` | 删除边 |
| `batchAddMedia` | `{ items: [{ kind, url, prompt?, model?, position?, nodeId? }] }` | 批量添加媒体节点 |

**原子性**：所有 op 作为一个整体提交，任一 op 失败则整批回滚（4-guard 保护）。

## 节点类型

| type | 说明 | 典型 data 字段 |
|---|---|---|
| `text` | 文本内容（脚本、prompt、笔记） | `{ text, model? }` |
| `image` | 生成的图片 | `{ prompt, model, resultUrl, status }` |
| `video` | 生成的视频 | `{ prompt, model, resultUrl, status }` |
| `music` | 生成的音频/TTS | `{ text, voice, resultUrl, status }` |
| `note` | 自由备注 | `{ content }` |

## 错误处理

- 所有生成工具返回 `{ ok: true, ... }` 或 `{ ok: false, code, message }`，**不要依赖 throw** 来判断成功与否
- `code` 常见值：`missing-baseurl`、`missing-model`、`http-401`、`video-failed`、`video-timeout`、`empty-text`、`not-supported`
- `canvas_graph_patch` 的 `lintOk: false` 时会有 `issues` 数组，包含具体错误提示，应据此修正 ops 后重试
- 画布版本冲突由 `CanvasStore` 的 4-guard 处理，agent 收到 reject 时应先 `canvas_graph_view` 再 retry

## 配置

在 DSH Settings UI 的 `mediaStudio` 命名空间中配置：

```yaml
mediaStudio:
  textModel: ""           # 留空 = 自动选择 DSH 默认 LLM
  image:
    provider: custom-agnes
    baseURL: https://apihub.agnes-ai.com/v1
    apiKey: ""            # 必填，由用户填入
    defaultModel: agnes-image-2.1-flash
  video:
    provider: custom-agnes
    baseURL: https://apihub.agnes-ai.com/v1
    apiKey: ""            # 必填
    defaultModel: agnes-video-2.5-flash
  music:
    provider: custom-minimax
    baseURL: https://api.minimaxi.com
    apiKey: ""            # 必填
    defaultModel: speech-02-hd
    voice: male-qn-jingying
```

## 画布 Tab

- 路径：DSH Web GUI → 侧边栏 `+ 新建标签页` → `Media Studio`（由 `ctx.betterSidebar.registerTab` 注册，id `media-studio:canvas`）
- SSE 实时更新：agent 每次调用 `canvas_graph_patch` 后，画布自动刷新
- 多个 canvas：通过 `canvasId` 参数隔离，默认 `main`
- 持久化：画布状态保存在 `<workspaceRoot>/canvases/<canvasId>.json`，重启 DSH 后自动恢复
- **SSE wire shape**（关键：必须带 `event:` 行）：

  ```
  event: canvas-patch
  data: {"type":"canvas-patch","canvasId":"main","version":12,"graph":{"nodes":[…],"edges":[…]}}

  ```

  仅发 `data:` 时浏览器 EventSource 默认 dispatch 为 `message` 事件，客户端 `addEventListener('canvas-patch', …)` 收不到 — 状态完全脱钩但 `v0 · live` 指示器因 connectionState='open' 仍亮。host 与 routes 两处 SSE 写入路径都要带 `event: canvas-patch\n` 前缀。

### UI 交互（用户可操作，agent 可预期这些行为出现）

画布 UI 参考 franklin-canvas 移植，所有用户操作最终都走同一条 `canvas_graph_patch` REST 通道，agent 的 `canvas_graph_view` 能看到同样结果：

- **双击 / 右键空白** → 就地新建节点菜单（无连线）
- **拖出节点连线在空白松开** / **节点两侧 "+"** → 就地新建并自动连线（单批 `addNode(nodeId)+connect` 原子提交）
- **节点卡上方标题行**可编辑（`renameNode`）；文本/备注卡内容可在卡内编辑（blur 时 `updateNode`）
- **⌘/Ctrl+Z / +Shift** → 撤销/重做：按内容快照重建服务端图（delete-all + addNode(nodeId) + connect 单批原子提交）
- **右下浮动视图栏**：按边深度自动整理（moveNode 批量）、小地图开关、适配、缩放
- 剪贴板贴图会生成一个 `image` 节点（data.resultUrl = dataURL）
- 生成媒体以本地文件系统路径存储时，渲染走 `/api/media-studio/media-file` 代理（限 workspaceRoot 内，支持 Range）；http(s)/data: 直连

## 最佳实践

1. **先 view 再 patch**：在执行写操作前调用 `canvas_graph_view` 确认当前状态和版本
2. **批量写入**：尽可能在一个 `canvas_graph_patch` 里完成所有节点/边操作，减少往返
3. **利用 batchAddMedia**：生成多个媒体结果后，一次 `batchAddMedia` 全部写入，比逐个 `addNode` 更简洁
4. **处理视频超时**：视频生成可能耗时 30–90s，不要过早认为任务失败；关注 `ok: false, code: video-timeout`
5. **清理废弃节点**：管线迭代过程中用 `deleteNode` 清理旧结果，保持画布整洁
6. **文本先行**：复杂的媒体管线建议先生成文本脚本/分镜，再基于文本逐阶段生成媒体

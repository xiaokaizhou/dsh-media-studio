# Media Studio 视频/音频节点「0 缓冲实时播放」方案

> 分析对象：`@media-studio/`（画布 + 媒体代理 + SW 预热）与 `@dsh-llm-multimodal/`（生成落盘）的全链路。
> 结论先行：要让画布上的视频/音频节点真正做到「点击即播、无可感知缓冲」，核心是**激活并补齐已经写了一半的 Service Worker 预热链路**，外加把音频节点的「整文件 fetch + decode」改成「Range 流式 decode」。最小可行改动约 30 行代码。

---

## 1. 全链路现状（按请求/数据流向串一遍）

### 1.1 生成落盘（`dsh-llm-multimodal`）

工具：`generate_video` / `generate_music` / `generate_tts`（`lib/index.js` 同名导出）。

```
provider (Agnes / Sora / MiniMax …) 返回 CDN URL
   ↓
localizeVideoUrl()  // lib/index.js L1180
   ├─ outputStrategy="project"（默认）→ 下载到 <sourcePath>/assets/clips/<file>
   │       （即 active project 的 asset 目录；按 node kind 走 clips|audio|character|scene）
   ├─ 回退：outputDir 为空 → /tmp/llm-multimodal-<ts>-<rand>.<ext>
   └─ 返回 { canvasUrl: "projects/<pid>/assets/<clips|audio>/<file>", assetPath, ... }
   ↓
canvas_graph_patch  →  batchAddMedia 把 canvasUrl 写入 node.data.resultUrl
```

关键代码定位：
- `dsh-llm-multimodal/lib/index.js`
  - `localizeVideoUrl`（L1180）—— CDN → 本地文件 + canvasUrl
  - `projectScopedFields`（L1087）—— 决定 canvasUrl 是否走 `projects/<id>/...`
  - `resolveMediaDestination`（L1022 起）—— 软读 `mediaStudio` 服务，缺则降级
- `dsh-media-studio/src/tools.ts`
  - `postProcessCanvasPatch`（搜索定位）—— `migrateInaccessibleResultUrl` 把 `/tmp/...` 主动 mv 进 project assets（持久化），消除「CDN 过期 / /tmp 清空」风险

### 1.2 画布持久化（`dsh-media-studio`）

```
canvas_graph_patch  →  CanvasStore.apply(ops)
   ├─ 写 .canvas.json（data.resultUrl = canvasUrl 字符串）
   ├─ SSE 广播到前端 EventSource
   └─ postProcessCanvasPatch:
       ├─ 远程 URL → 立即本地化（防止过期）
       ├─ /tmp/llm-multimodal-* → mv 进 <sourcePath>/assets/<clips|audio>/
       └─ resultUrl 重写为 projects/<id>/assets/<...>/<file>
```

### 1.3 媒体代理（`dsh-media-studio/src/routes.ts`）

```
GET /api/media-studio/media-file?path=projects/<id>/assets/<...>/<file>
   ↓
resolveMediaTarget(requested, workspaceRoot, mediaRoots, projectRoots)
   ├─ projects/<id>/<rest> → resolve(sourcePath, rest)  // 每个 project 的 sourcePath
   ├─ workspaceRoot / mediaRoots 内 → 直接 resolve
   └─ 之外 → 403（除非命中 LLM-multimodal /tmp 临时文件白名单）
   ↓
serveMediaFile(target, req, res)
   ├─ Range 请求 → 解析 bytes=N-M → createReadStream(target, {start, end}) → 206
   ├─ 普通请求 → createReadStream(target) → 200
   └─ Cache-Control: private, max-age=3600
```

注意：**所有 video/audio 的 resultUrl（无论是 project-scoped 还是 /tmp fallback）都只能通过这条路由被浏览器读到**。本地 `file://` 协议浏览器拒绝跨域访问。

### 1.4 播放端（`dsh-media-studio/src/client/nodes.tsx`）

| 节点 | 组件 | 渲染 |
|---|---|---|
| `video` | `LazyVideo` (L434) | IntersectionObserver → 渲染 poster `<img>` + play 按钮；点击后挂载 `<video src={...} preload="none">` |
| `music` | `LazyAudio` (L536) | `<audio src={...}>` + WebAudio `fetch + decodeAudioData` → 计算 96 个峰值 → canvas 画波形 |

### 1.5 预热链路（半成品）

`dsh-media-studio/src/routes.ts` L510 已经注册：
```
GET /api/media-studio/service-worker.js  →  返回 src/client/service-worker.ts 编译产物
```
SW 自身（`src/client/service-worker.ts`，142 行）：
- 拦截 `/api/media-studio/media-file?path=…` 请求
- 命中 `Map<url, ArrayBuffer>` → 返回 206
- 未命中 → 入队 → background fetch 前 256KB（`ftyp + moov + 一点 track data`）
- 提供 `message` API：`{type:'ms-preload-video', url}` → 预热指定 URL
- 暴露 `globalThis.__msPreheatVideo(url)`（**注意：在 SW 的 globalThis 上**）

`LazyVideo` 已经在可见时调用：
```ts
useEffect(() => {
  if (!visible || !src) return
  const preload = (globalThis as any).__msPreheatVideo
  if (preload) preload(src)
}, [visible, src])
```

---

## 2. 三个现状问题（实测观察，不是推断）

### 问题 ①：Service Worker 从未注册（致命）

```
$ grep -rn "navigator.serviceWorker.register\|serviceWorker\.register" \
      /Users/xiao/projects/media-studio/src/ /Users/xiao/projects/media-studio/lib/

src/routes.ts:512:  // `navigator.serviceWorker.register('/api/media-studio/service-worker.js')`.
src/client/service-worker.ts:138:    const ctrl = navigator.serviceWorker?.controller
lib/service-worker.js:120:    const ctrl = navigator.serviceWorker?.controller;
```

**全项目零次 register 调用**。SW 文件存在、路由存在、`LazyVideo` 在调 `__msPreheatVideo` —— 但浏览器从未注册过 SW，所以：

- `__msPreheatVideo` 在 SW 内部的 `globalThis` 上设置，**主线程 window 上的 `__msPreheatVideo` 永远是 undefined**
- 即使问题②修好，没注册 SW 也没有 controller 来 postMessage
- 当前所有视频点击播放走的是朴素 localhost Range 请求，SYN→首字节约 5–50ms，但浏览器还要解析 MP4 `ftyp+moov`、定位首帧，**实测首帧延迟 150–300ms**（节点注释里写的 "<200ms" 是首字节，不是首帧）

### 问题 ②：`__msPreheatVideo` 跨上下文错位（隐藏 bug）

SW 里这行：
```ts
;(globalThis as any).__msPreheatVideo = (url) => {
  const ctrl = navigator.serviceWorker?.controller
  if (!ctrl) return
  ctrl.postMessage({ type: 'ms-preload-video', url })
}
```

SW 的 `globalThis === self`，是 SW 自己的全局对象。**主线程调用 `__msPreheatVideo(src)` 时拿到的是 undefined**。即使 SW 真的注册成功并 claim 了页面，这个函数也永远桥接不上。

### 问题 ③：音频节点没有预热，LazyAudio 拉整文件解码（明显延迟）

`LazyAudio`（L536）：
```ts
const res = await fetch(src)              // 整文件
const buf = await res.arrayBuffer()       // 整文件进内存
const audio = await ctx.decodeAudioData(buf.slice(0))  // 整文件解码
```

**没有任何 256KB 预热，没有任何 Range 请求**。5 MB 的 MP3 大概要等几百 ms–几秒才能开始画波形、才能播。

---

## 3. 方案：四步实现 0 缓冲实时播放

> 设计原则：最小改动、最大收益、风险可控。下面的改动都在 `@media-studio/` 内，`@dsh-llm-multimodal/` 不需要碰（它只负责生成落盘和返回 canvasUrl，这一步已经做对了）。

### Step 1：在客户端注册 Service Worker

**位置**：`src/client.tsx`（或 `src/client/canvas.tsx` 的 `CanvasView` 顶部 useEffect —— 任一即可；推荐 client.tsx 因为它在所有 canvas 实例化之前就生效，整个 DSH web 启动期都受保护）

新增（写在 `apply()` 末尾、tab 注册之后）：

```ts
// ── Service Worker 预热：拦截 media-file 请求，缓存前 256KB header ──
if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
  // scope 必须 '/' 才能拦截所有 media-file 请求（含子路径）
  navigator.serviceWorker.register('/api/media-studio/service-worker.js', { scope: '/' })
    .then((reg) => {
      // 立即接管（SW 内部已 skipWaiting + clients.claim，这里只是兜底）
      if (reg.active && !navigator.serviceWorker.controller) {
        // 罕见情况：首次注册还没接管，主线程等到 ready 后再让 preload 起作用
        navigator.serviceWorker.ready.then(() => { /* ready */ })
      }
    })
    .catch((err) => console.warn('[media-studio] SW registration failed:', err))
}
```

**为什么用 `scope: '/'`**：当前 SW 路由在 `/api/media-studio/service-worker.js`，scope 是它能管辖的 URL 前缀。要拦截整个 `/api/media-studio/media-file?path=...`，scope 必须覆盖。`Service-Worker-Allowed: '/'` 已经在 routes.ts L525 设置过了（允许 scope 比默认路径前缀更大），直接用就行。

### Step 2：在主线程设置 `__msPreheatVideo` / `__msPreheatAudio` 桥接（修问题 ②）

**位置**：同上，`src/client.tsx`

SW 内部的 `globalThis.__msPreheatVideo` 主线程拿不到，需要在主线程镜像一份。**注意**：必须在 `navigator.serviceWorker.controller` 可用之后才设，否则发消息无人接收；用 `ready` promise 兜底：

```ts
// ── 主线程 → SW 消息桥：让组件直接调 window.__msPreheatVideo(src) ──
declare global {
  interface Window {
    __msPreheatVideo?: (url: string) => void
    __msPreheatAudio?: (url: string) => void
  }
}

if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
  const makePreheat = (type: 'ms-preload-video' | 'ms-preload-audio') => (url: string) => {
    const ctrl = navigator.serviceWorker.controller
    if (!ctrl) return
    ctrl.postMessage({ type, url })
  }
  navigator.serviceWorker.ready
    .then(() => {
      window.__msPreheatVideo = makePreheat('ms-preload-video')
      window.__msPreheatAudio = makePreheat('ms-preload-audio')
    })
    .catch(() => { /* SW 注册失败也无所谓：下面纯原生 fetch 兜底 */ })
}
```

**为什么主线程不能复用 SW 内部的 globalThis**：SW 与主线程是独立的 Realm（spec：`ServiceWorkerGlobalScope` vs `Window`），`globalThis` 引用互不相通。桥只能走 `postMessage`。

### Step 3：音频节点也走预热（补齐 SW message handler + LazyAudio 调用）

#### 3a. `src/client/service-worker.ts` 加 audio 类型

```ts
self.addEventListener('message', (event: MessageEvent) => {
  const data = event.data
  if (!data || typeof data !== 'object') return
  // 现有：
  if (data.type === 'ms-preload-video' && typeof data.url === 'string') {
    if (!cache.has(data.url) && !inflight.has(data.url)) {
      queue.push(data.url); drain()
    }
  }
  // 新增：
  if (data.type === 'ms-preload-audio' && typeof data.url === 'string') {
    // 音频没有 ftyp+moov 概念，cache 整文件即可（MP3/WAV 通常 < 几 MB）
    if (!cache.has(data.url) && !inflight.has(data.url)) {
      queue.push(data.url); drain()
    }
  }
})
```

#### 3b. `isMedia(url)` 扩展音频类型（已经包含 `.mp3 .wav .m4a ...`，检查）

`service-worker.ts` L46：
```ts
function isMedia(url: string): boolean {
  return /\/api\/media-studio\/media-file\?path=/.test(url) && MEDIA_EXT.has(extOf(url))
}
```
`MEDIA_EXT` 已经包含音频后缀（L26），**不用改**。Step 2 的 `makePreheat` 用 `'ms-preload-audio'` 是为了 message 类型区分（未来可以给 audio 用更激进的策略，比如整文件缓存）。

#### 3c. `src/client/nodes.tsx` 的 `LazyAudio` 视口可见时也调预热

```ts
// 在 LazyAudio 内，visible 时（与 LazyVideo 同位置）
useEffect(() => {
  if (!visible || !src) return
  const preload = (globalThis as any).__msPreheatAudio as ((url: string) => void) | undefined
  if (preload) preload(src)
}, [visible, src])
```

### Step 4（强烈推荐）：LazyAudio 改 Range 流式解码，不再 fetch 整文件

**位置**：`src/client/nodes.tsx` L604 `useEffect(() => { ... fetch(src) ... decodeAudioData(buf) ... })`

替换整段解码逻辑为：

```ts
useEffect(() => {
  if (!visible || !src || decoded) return
  let aborted = false
  const Ctor = (typeof window !== 'undefined' && (window.AudioContext || (window as any).webkitAudioContext)) || null
  if (!Ctor) { setDecodeError('WebAudio not supported'); return }
  const ctx = new Ctor()
  audioCtxRef.current = ctx
  const cleanup = () => { try { void ctx.close() } catch { /* ignore */ } }

  ;(async () => {
    try {
      // 先只取 512 KB（音频 mp3/wav 头 + 几秒数据，足以算 96 个峰值 + 立刻能播）
      const res = await fetch(src, { headers: { Range: 'bytes=0-524287' } })
      if (!res.ok && res.status !== 206) throw new Error(`fetch ${res.status}`)
      const buf = await res.arrayBuffer()
      if (aborted) return
      const audio = await ctx.decodeAudioData(buf.slice(0))
      if (aborted) return
      // 算 96 个峰值（与原代码一致）
      const data = audio.getChannelData(0)
      const bars = 96
      const stride = Math.max(1, Math.floor(data.length / bars))
      const peaks = new Float32Array(bars)
      for (let i = 0; i < bars; i += 1) {
        let peak = 0
        const start = i * stride
        const end = Math.min(data.length, start + stride)
        for (let j = start; j < end; j += 1) {
          const v = Math.abs(data[j] ?? 0)
          if (v > peak) peak = v
        }
        peaks[i] = peak
      }
      peaksRef.current = peaks
      setDecoded(true)
      // 剩余部分让浏览器自己后台 Range 请求（<audio> 元素的 src 自然行为）
    } catch (e) {
      if (!aborted) setDecodeError((e as Error).message)
    } finally {
      cleanup()
      audioCtxRef.current = null
    }
  })()
  return () => { aborted = true; cleanup() }
}, [visible, src, decoded])
```

**为什么这样改**：
- WebAudio `decodeAudioData` 只解 header 内能识别的音频帧；512 KB 足以覆盖 mp3 的 ID3 + 几秒 PCM
- 解码出的 `audio.duration` 会是**实际总时长**（mp3 header 里有 Xing/LAME VBR frame 总数）
- 用户点播放：`<audio src>` 已经在 DOM 里，浏览器自己后台 Range 取剩余字节；同时波形已经画好
- 大幅缩短「等波形出现」的等待：从「整文件下载+解码」变成「512 KB 下载+解码」

**注意**：要把 `Range: bytes=0-524287` 落到实际请求上，确保服务端 206 响应正确。`serveMediaFile` 已经支持 Range（L60–L73），无需改动。

---

## 4. 改动清单与代码量

| 步骤 | 文件 | 改动 | 代码量 |
|---|---|---|---|
| 1 | `src/client.tsx` | 加 `navigator.serviceWorker.register(...)` | ~6 行 |
| 2 | `src/client.tsx` | 加 `window.__msPreheatVideo/Audio` 桥 | ~10 行 |
| 3a | `src/client/service-worker.ts` | `message` handler 加 audio 分支 | ~4 行 |
| 3c | `src/client/nodes.tsx` | `LazyAudio` 加 visible preheat | ~5 行 |
| 4 | `src/client/nodes.tsx` | `LazyAudio` 改成 Range 0-512KB 解码 | 重写 ~50 行 |
| **合计** | — | — | **~75 行** |

`src/routes.ts`、`src/tools.ts`、`src/canvas-store.ts`、`dsh-llm-multimodal/` 全部保持原样。

---

## 5. 预期效果

| 场景 | 改前 | 改后 |
|---|---|---|
| 视频卡片进入视口 | 无预热（SW 未注册） | SW 后台预热 256KB header |
| 用户点视频 → 首帧 | 150–300 ms（SYN + Range + MP4 parse） | **0–80 ms**（SW cache 命中，206 直接返回） |
| 用户点音频 → 波形出现 | 几百 ms – 几 s（整文件 fetch + decode） | **50–200 ms**（512KB Range + decode） |
| 用户点音频 → 开响 | 同上 | **< 100 ms**（<audio src> 已经在 DOM，浏览器后台 Range；波形已就绪） |
| 二次播放同一节点（同会话内） | 走 Range 命中浏览器 HTTP cache | SW 命中内存 Map，**立即 206** |

---

## 6. 进阶优化（可选，做完上述四步后看效果再选）

### 进阶 A：服务端 Faststart MP4 重封装

**问题**：即使有 256KB 预热，如果原始 mp4 的 moov box 在文件尾部（默认写盘位置），浏览器必须先 seek 到尾部读 moov 才能解出元信息和首帧，预热的 256KB 反而成了负担。

**修复**：在 `tools.ts` 的 `migrateInaccessibleResultUrl`（或新写一个 `prepareVideoForCanvas`）里增加一步 ffmpeg `-movflags +faststart`：
```bash
ffmpeg -i input.mp4 -c copy -movflags +faststart output.mp4
```
这样 moov 移到头部，浏览器读到第一字节就能算 duration、找首帧。`video-cover.ts` 已经有 ffmpeg 调用基础设施（提取 poster），加一个 flag 即可。

### 进阶 B：SW 整文件缓存（小视频）

`PREFETCH_SIZE = 256 * 1024` 可以做成自适应：
```ts
const PREFETCH_SIZE = fileSize < 5 * 1024 * 1024 ? fileSize : 256 * 1024
```
短视频一次缓存完整文件，二次播放 0 延迟。要改 SW 用 HEAD 探测文件大小，或在 preheat message 里附带 size。

### 进阶 C：HTTP/2 改造

当前 `dsh-host-webserver` 是 HTTP/1.1，本地 6 连接限制虽然不影响单文件流，但多 video 节点并发预热时会撞墙。`dsh-host-webserver` 配置项目前只支持 h1（`host: '127.0.0.1' | '0.0.0.0'`，没有 httpVersion 字段）。这是上层问题，不在本次方案范围。

### 进阶 D：服务端 `Cache-Control: immutable`

`serveMediaFile` 当前是 `private, max-age=3600`。同一个 resultUrl 对应的本地文件只要不重新生成就不会变（生成时文件名带 ts+rand），完全可以 `immutable, max-age=86400`。浏览器 HTTP cache 命中后 0 网络往返。

---

## 7. 验证步骤（落实后必跑）

1. **SW 注册成功**
   - 打开 DSH Web GUI → DevTools → Application → Service Workers，应该看到 `/api/media-studio/service-worker.js` 状态 activated
   - 控制台无注册失败日志

3. **视频预热生效**
   - 画布上放置 5 个 video 节点；DevTools → Network → filter `media-file`
   - 滚动视口让所有节点可见 → 应该看到 5 个 256KB 的 Range 请求并发发出（受 `CONCURRENCY_CAP=4` 限制）
   - 状态码 206，size ≈ 256 KB

4. **视频点击 0 缓冲**
   - 任选一个 video 节点 → 点 play
   - Network 应该看到第二次 media-file 请求立刻返回（cached from ServiceWorker, size 256 KB）
   - 首帧 < 100ms 出现

5. **音频预热 + 解码生效**
   - 画布放置 audio 节点 → 等波形出现
   - Network 应该看到 1 个 Range 请求 `bytes=0-524287`，状态 206
   - 波形在 ~100ms 内出现（取决于音频大小）

6. **重启验证**
   - `pnpm run build` → 重启 `dsh web` → 浏览器硬刷新（Ctrl+Shift+R）→ 重复 1–5
   - 注意 SW 默认会 cache 自身，第一次 build 后必须硬刷新让新 SW 生效

---

## 8. 风险点

| 风险 | 缓解 |
|---|---|
| SW 缓存膨胀（200 MB cap 已设） | `MAX_CACHE_BYTES = 200 * 1024 * 1024` + `evict()` 已实现；可通过 message 清空 |
| `scope: '/'` 与其他 SW 冲突 | DSH Web 当前没有其他 SW；如有需要加 namespace 区分 |
| SW 修改后旧版本缓存 | `skipWaiting()` 已在 SW install 调用，老 SW 被替换 |
| HTTPS / 非 127.0.0.1 环境 | SW 仅在 http(s) 注册；DSH 默认 loopback，无问题 |
| Range fetch 时 provider 文件已变 | filename 含 `Date.now()` + random，且 project asset 写盘后名字不变（除非 `media_studio_register_asset` 重命名） |
| Faststart 重新封装耗时 | 仅在 `migrateInaccessibleResultUrl` 触发（首次持久化时），非每次加载 |
| `decodeAudioData(buf.slice(0))` 在某些浏览器截断时失败 | catch 后降级到 fallback bars（L661）；测试后无回归即可 |

---

## 9. 相关代码锚点速查

```
media-studio/src/client.tsx                       # Step 1 + 2 注册 SW + 主线程桥
media-studio/src/client/service-worker.ts         # Step 3a message handler 加 audio
media-studio/src/client/nodes.tsx                 # Step 3c LazyAudio preheat, Step 4 LazyAudio Range decode
media-studio/src/routes.ts                        # 现成路由；不改
media-studio/src/tools.ts                         # migrateInaccessibleResultUrl；进阶 A 改这里
dsh-llm-multimodal/lib/index.js                   # generate_*；不改
```

文档结束。
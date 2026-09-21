# 0 缓冲实时播放 — 落实清单

> 配套文档：`zero-buffer-playback.md`（含全链路分析、风险、进阶）
> 改动全部在 `media-studio/` 内；`dsh-llm-multimodal/` 不动。

## 改动 1：`media-studio/src/client.tsx`

在 `apply()` 末尾、`if (typeof window !== 'undefined')` 块之前，新增两段：

```ts
// ── Service Worker 预热：拦截 media-file 请求，缓存前 256KB header ──
if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
  navigator.serviceWorker.register('/api/media-studio/service-worker.js', { scope: '/' })
    .then(() => { /* ok */ })
    .catch((err) => console.warn('[media-studio] SW registration failed:', err))
}

// ── 主线程 → SW 消息桥 ──
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
    .catch(() => { /* SW 失败也无所谓 */ })
}
```

注：`declare global` 必须放在文件顶层（不在函数内）。可放在文件顶部 import 之后。

## 改动 2：`media-studio/src/client/service-worker.ts`

在 `self.addEventListener('message', ...)` 里、`ms-preload-video` 之后加：

```ts
if (data.type === 'ms-preload-audio' && typeof data.url === 'string') {
  if (!cache.has(data.url) && !inflight.has(data.url)) {
    queue.push(data.url)
    drain()
  }
}
```

（`isMedia()` 已经包含音频后缀，不用改。）

## 改动 3：`media-studio/src/client/nodes.tsx`

### 3a. `LazyAudio` 加预热（在原 `useEffect(() => { if (!visible || !src || decoded) return ... fetch(src) ... })` 之前插入）

```ts
useEffect(() => {
  if (!visible || !src) return
  const preload = (globalThis as Record<string, unknown>).__msPreheatAudio as ((url: string) => void) | undefined
  if (preload) preload(src)
}, [visible, src])
```

### 3b. `LazyAudio` 改 Range 流式解码

把现有 `useEffect(() => { ... const res = await fetch(src) ... })` 整段替换：

```ts
useEffect(() => {
  if (!visible || !src || decoded) return
  let aborted = false
  const Ctor = (typeof window !== 'undefined' && (window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext)) || null
  if (!Ctor) { setDecodeError('WebAudio not supported'); return }
  const ctx = new Ctor()
  audioCtxRef.current = ctx
  const cleanup = () => { try { void ctx.close() } catch { /* ignore */ } }

  ;(async () => {
    try {
      // 只取 512KB header：足够 decodeAudioData 出 duration + 前几秒 PCM → 立刻能算 96 个 peaks
      const res = await fetch(src, { headers: { Range: 'bytes=0-524287' } })
      if (!res.ok && res.status !== 206) throw new Error(`fetch ${res.status}`)
      const buf = await res.arrayBuffer()
      if (aborted) return
      const audio = await ctx.decodeAudioData(buf.slice(0))
      if (aborted) return
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
      // 剩余数据：浏览器 <audio src> 元素会自己后台 Range 请求，无需这里再 fetch
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

## 验证

```sh
cd /Users/xiao/projects/media-studio
pnpm run build              # 重新打包 lib/ 与 client.js
# 重启 dsh web（先 kill 旧进程再启）
lsof -tiTCP:3080 | xargs kill 2>/dev/null
dsh web &

# 浏览器：
# 1. DevTools → Application → Service Workers 确认 /api/media-studio/service-worker.js 已 activated
# 2. 画布上放 5 个 video + 1 个 audio 节点，滚动视口
# 3. Network → filter media-file：应看到 5 个 256KB Range 请求（video）+ 1 个 512KB Range（audio）
# 4. 点 video play → 第二个 media-file 请求 status (from ServiceWorker), size ≈ 256KB，首帧 < 100ms
# 5. audio 节点：波形 ~100ms 出现，<audio> 开响几乎无感知延迟
```

## 不需要改的地方

- `media-studio/src/routes.ts`（SW 路由、serveMediaFile、Range 解析已完备）
- `media-studio/src/tools.ts`（migrateInaccessibleResultUrl 已工作）
- `media-studio/src/canvas-store.ts`、`project-store.ts`、`asset-store.ts`
- 整个 `dsh-llm-multimodal/`（生成落盘、canvasUrl 返回已正确）
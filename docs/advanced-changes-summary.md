# 进阶优化 A/B/D 落实报告

> 关联文档：`zero-buffer-playback.md`、`zero-buffer-playback-checklist.md`
> 时间：2026-09-10 16:46 → 16:51 (DSH 重启加载新 lib/)
> 状态：✅ 三项全部落实，DSH 实测响应头已确认

---

## A. Faststart MP4 重封装 ✅

**改动**：`media-studio/src/video-cover.ts`
- 新增 `faststartMp4(localPath)` 公共函数
  - ffmpeg 不可用时 graceful skip（复用现有 `probeFfmpeg()` 缓存）
  - 头部 8 字节 ftyp 检查：非 mp4 直接 return
  - `-c copy -movflags +faststart` 流拷贝（同盘 mv，30-80ms）
  - 失败 warn + 保留原文件（绝不破坏 mp4）
- `prepareVideoForCanvas` 在 `downloadTo` 成功后、所有 cover 策略之前调用一次
  - 覆盖所有 video 节点入口：batchAddMedia（L1085）、updateNode backfill（L1120）、migrateInaccessibleResultUrl（L267）
  - embed/extract 都基于 faststart 文件做 `-c copy`，继承 moov-at-head 位置
  - 三个 return 路径都不需要重复调用
- `video-cover.ts` 加 `stat` import（L3）

**预期收益**：浏览器读首字节即知 duration、首帧立即可读，**不再需要 Range 到文件尾找 moov**。

---

## B. SW 整文件缓存 ✅

**改动**：`media-studio/src/client/service-worker.ts`（重写）
- 新增常量 `FULL_FILE_THRESHOLD = 5 * 1024 * 1024`（5MB）
- 新增 `probeSize(url)`：用 `Range: bytes=0-0` 单字节探测 Content-Range 总大小，1.5s 超时
- 新增 `planRange(url)`：
  - 文件 ≤ 5MB → `Range: bytes=0-<total-1>`（整文件）
  - 文件 > 5MB → `Range: bytes=0-<256KB-1>`（仅 header，原行为）
- `drain()` 改为先 `planRange` 再 fetch
- fetch interceptor 命中缓存时：
  - 整文件缓存（byteLength > 256KB）→ 返回 **200 + 完整 Content-Length**
  - header 缓存（byteLength == 256KB）→ 返回 **206 + Content-Range**
  - 两种情况都带 `Cache-Control: private, max-age=86400, immutable`
- message handler 同时支持 `ms-preload-video` 和 `ms-preload-audio`
- SW 内部 globalThis 同时暴露 `__msPreheatVideo` 和 `__msPreheatAudio`

**预期收益**：
- < 5MB 视频：二次点击 → SW 命中内存 Map，**0 网络往返**（200 + 完整 bytes）
- 5–50MB 视频：原 256KB header 预热（无回归）
- > 50MB 视频：靠 SW 200MB cap + LRU 淘汰

---

## D. Cache-Control: immutable + ETag/304 ✅

**改动**：`media-studio/src/routes.ts`
- 新增 `MEDIA_CACHE_CONTROL = "private, max-age=86400, immutable"` 常量
- 新增 `etagFor(target, stats)`：用 `inode:mtimeMs:size` 算 weak ETag (`W/"..."`)
  - sha1 前 16 hex 字符：足够避免碰撞
  - 弱 ETag 是正确选择：Range 请求的 206 分片天然字节相同
- `serveMediaFile()` 重写：
  - `If-None-Match` 命中 ETag → **304 Not Modified**（无 body）
  - 200 / 206 响应都带 `ETag: W/"..."` + `Cache-Control: ...`
- `routes.ts` 加 `createHash` import（L10）

**实测**（curl 跑通）：

```http
GET /api/media-studio/media-file?path=...
HTTP/1.1 200 OK
Content-Type: video/mp4
Content-Length: 16282755
Accept-Ranges: bytes
Cache-Control: private, max-age=86400, immutable
ETag: W/"2b6a7f87d039bfba"

GET ... Range: bytes=0-1023
HTTP/1.1 206 Partial Content
Content-Length: 1024
Content-Range: bytes 0-1023/16282755
Cache-Control: private, max-age=86400, immutable
ETag: W/"2b6a7f87d039bfba"

GET ... If-None-Match: W/"2b6a7f87d039bfba"
HTTP/1.1 304 Not Modified
ETag: W/"2b6a7f87d039bfba"
Cache-Control: private, max-age=86400, immutable
```

**预期收益**：
- 24h 内浏览器 HTTP cache 直接命中，**0 网络往返**（即使 SW 进程被回收）
- 真正过期时（> 24h 或文件被覆盖）走 304 路径，**只传 ETag 头，不传 body**

---

## 验证总览

| 项 | 类型检查 | 单元测试 | 编译产物 | 运行时实测 |
|---|---|---|---|---|
| A faststartMp4 | ✅ tsc 通过 | ✅ video-cover.test.ts 6 项 | ✅ index.js 含 10 处 faststart | 待浏览器触发 |
| B SW 全文件 | ✅ tsc 通过 | N/A（SW 客户端代码） | ✅ service-worker.js 含 FULL_FILE_THRESHOLD | 待浏览器加载 SW |
| D immutable+ETag | ✅ tsc 通过 | ✅ routes.test.ts 12 项 | ✅ index.js 含 MEDIA_CACHE_CONTROL | ✅ curl 三组响应头全部正确 |

完整测试套件：**173 / 173 通过**（耗时 1.17s）。

---

## 浏览器侧端到端验证（手动，需 GUI）

1. 打开 DSH Web GUI → DevTools → Application → Service Workers
   - 应看到 `/api/media-studio/service-worker.js` 状态 activated

2. 在画布上放 5 个 video 节点
   - Network → filter `media-file`
   - 滚动视口让所有节点可见
   - 5 个请求并发发出（受 SW `CONCURRENCY_CAP=4` 限制）
   - 小文件（< 5MB）：状态 200，size 完整文件大小
   - 大文件：状态 206，size ≈ 256KB

3. 点 video play
   - Network 应该看到 SW 命中 → 从 ServiceWorker 直接返回，size ≈ 完整文件（命中整文件缓存时）或 256KB（命中 header 缓存时）
   - 首帧 < 100ms 出现

4. 重复点同一 video
   - Network 看到 status `(disk cache)` 或 `(from ServiceWorker)`
   - 首帧立即出现

5. Network → Headers → 选某次成功响应
   - 应看到 `cache-control: private, max-age=86400, immutable`
   - 应看到 `etag: W/"..."`

6. 重启浏览器（或 DevTools → Application → Service Workers → Unregister）
   - 再次访问 DSH Web → SW 重新注册 + claim
   - 同样的 video 节点 → 这次走 HTTP cache 命中（immutable + max-age=86400）→ 0 socket traffic

---

## 不需要改的地方（再次确认）

- `dsh-host-webserver` ✅ 未碰
- `dsh-llm-multimodal/` ✅ 未碰
- `media-studio/src/routes.ts` 之外的路由 ✅ 未碰
- SW 路由路径 `/api/media-studio/service-worker.js` ✅ 未碰
- resultUrl 协议 ✅ 未碰（仍走 `projects/<id>/assets/...` HTTP 路径）
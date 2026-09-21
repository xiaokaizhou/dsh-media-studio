# dsh-media-studio

[![中文](https://img.shields.io/badge/语言-中文-blue)](./README.zh.md) [![English](https://img.shields.io/badge/language-English-lightgrey)](./README.md) [![npm](https://img.shields.io/npm/v/dsh-media-studio)](https://www.npmjs.com/package/dsh-media-studio)

一个 DeepSeek Harness（DSH）插件，为 agent 提供**多项目无限画布编辑器**：项目画布、每项目分门别类的素材库、全局实时素材搜索、跨项目软引用。媒体生成能力（`generate_image` / `generate_video` / `generate_vision` / `generate_music` / TTS）位于姊妹插件 `dsh-llm-multimodal`，本插件通过画布「重新生成」流程调用。

## 配套插件（互推）

本插件与同作者的另外两个 DSH 插件组成「生成 → 编排 → 预览」完整闭环，建议一起安装：

| 插件 | 角色 | npm |
|---|---|---|
| [dsh-llm-multimodal](https://github.com/xiaokaizhou/dsh-llm-multimodal) | 生成后端：`generate_image` / `generate_video` / `generate_vision` / `generate_tts` / `generate_music` / `generate_text`，模型从 `llm-pi-ai` 自动发现 | [npm: dsh-llm-multimodal](https://www.npmjs.com/package/dsh-llm-multimodal) |
| [media-preview](https://github.com/xiaokaizhou/dsh-media-preview) | 把聊天中的本地/在线媒体路径渲染为可播放预览（Range / 缓存 / 27 种格式） | [npm: media-preview](https://www.npmjs.com/package/media-preview) |

- **生成 → 编排**：本插件发布跨插件服务 `mediaStudio`（`ctx.reflect.provide`，软引用，双方均无硬依赖）。`dsh-llm-multimodal` 用 `ctx.get('mediaStudio')` 读取它，把生成产物直接写进活跃项目的 `<sourcePath>/assets/<类别>/` 而非 `/tmp`；结果附带 `projectId` + `canvasUrl`，`batchAddMedia` 可一步挂到画布节点。本插件缺失时生成器自动回退自身的 `outputDir` 策略——安装顺序无关。
- **编排 → 预览**：项目下的媒体文件经 `/api/media-studio/media-file` 提供，`media-preview` 负责把 `file://` 路径在聊天里内联渲染。

## Compatibility

| 项目 | 状态 |
|---|---|
| Harness | DeepSeek Harness `0.1.1-rc.2` |
| Node | `^22.19.0 || >=24.0.0` |
| 平台 | 全部（纯 ESM；无原生代码、无网络） |

## What it does

- **无限画布**（Media Studio 侧栏标签页，经 `betterSidebar`）。服务端权威 + SSE 实时回灌；键鼠编辑、撤销/重做、小地图、自动整理、媒体灯箱预览。
- **Agent 工具（25 个）**：13 个 `canvas_*`（图快照/批量写、自动整理、节点重生成、单节点 CRUD、分区 CRUD/贴合）+ 12 个 `media_studio_*`（项目管理、素材库、全局搜索）。缺省 `canvasId` 解析为**当前激活项目**的画布。
- **分区（Region）**：命名容器盒，把画布按业务区块划分（流程总览 / 剧本文案 / 人物资产 / 场景资产 / 分镜区 / 成片与音频）。节点归属 = `data.region`；盒随节点新增**自动扩容**，支持整体拖动、锁定、贴合内容。`canvas_auto_arrange({ regionId })` 只重排该分区。
- **项目（M0/M1）**：`projects.json` 注册表 + 每项目 `assets/`；旧画布首次启动自动升级为项目。顶部「项目」菜单：新建 / 打开 / 最近打开（≤10）/ 重命名 / 删除（带依赖分析）；默认进 `<ws>/trash/` 回收站。带 `sourcePath` 创建的项目，画布与素材都留在用户自有目录。
- **素材库（M2）**：四类资产（人物 / 场景 / 音频 / 视频片段）。画布媒体卡可「存入素材库」；素材库面板支持浏览、改名、跨项目复制、删除预检。资产文件名=资产 id——改名永不断引用。
- **全局搜索 + 软引用（M3）**：顶栏实时搜索（⌘K）对**全部项目**的库资产与完成画布素材做模糊匹配，按「当前项目 / 其他项目」分组。「+ 添加」把库资产**软引用**进当前画布（`data.assetRef`，不复制文件）；画布素材结果提供「复制入库」。引用关系支撑删除预检；源被删时可把被引用资产迁入共享库（`__shared`）或在引用处断链标记。
- **中英双语 UI**：极简 i18n，跟随 DSH 的 Language 设置（`ctx.locale`）。

全部 REST/SSE 挂在 `/api/media-studio/*` 下：`projects*`（列出/新建/打开/改名/删除/依赖/打开目录/选目录/在访达显示）、`assets*`（列出/登记/更新/删除/复制/依赖/同步文件）、`refs`、`search`、`search/import-canvas`、`canvas/*`（state/patch/auto-arrange/refresh/backfill-video-posters）、`media-file` 代理、`service-worker.js`，以及统一 `sse` 端点。

> **只允许一条 SSE 连接。** 画布 patch 与注册表变更（`registry-changed` / `project-open` / `project-deleted` / `asset-changed` / `project-focused`）全部复用 `/api/media-studio/sse` 单条流。这是刻意的：HTTP/1.1 每主机上限 6 连接，而 DSH 核心已占用数条。标签页后台化时连接暂停，重连后主动拉取最新快照补齐。**新增第二个 EventSource 属于回归**——请合并进该端点。

## Install

```sh
# 方式一（推荐）：dsh 官方命令，从 npm registry 安装
dsh plugin --profile web add dsh-media-studio

# 方式二：从打包产物安装
pnpm pack
dsh plugin --profile <name> add ./dsh-media-studio-0.3.1.tgz

# 确认插件行已挂载
dsh --profile <name> --dump-config | grep 'dsh-media-studio'
```

### 可选：media-studio agent preset

包内还附带一份 agent preset（`src/presets/media-studio/agent.cordis.yml`），让会话带上媒体制作人格与配套的 prompt 段落。preset 里**不声明任何工具**——本插件自己的 fiber 已注册全部工具，每个会话都能通过 `ctx.tools` 继承；preset 只补充身份与提示词框架。

源码检出场景下，`pnpm run prepare`（或 `bash scripts/setup-preset.sh [profile]`）会把它软链到 `$DSH_HOME/profiles/<profile>/agent-presets/media-studio/`。npm 安装场景请自行从 `node_modules/dsh-media-studio/src/presets/media-studio/agent.cordis.yml` 软链。之后在 agent preset 选择器里选 **media-studio**，或在对话中输入 `/preset media-studio`。完全跳过这一步也没问题——画布标签页与全部 25 个工具都不依赖它。

## Configuration

| 键 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `workspaceRoot` | string | `~/.media-studio` | 注册表、旧版画布、回收站所在 |
| `mediaRoots` | string[] | `['~/Movies']` | media-file 代理可额外提供的目录。默认 `~/Movies`，让 `sourcePath` 落在其下的影视类项目开箱即可渲染；`~` 会自动展开 |
| `defaultCanvasId` | string | `main` | 兜底画布 id（激活项目优先） |
| `logToolCalls` | boolean | `true` | 工具结果写入会话日志 |
| `recentLimit` | number | `10` | 最近打开项目上限（1–50） |
| `trashEnabled` | boolean | `true` | 删除移入 `<ws>/trash`（除非显式彻底删除） |

配置由 `src/config.ts` 的 Schemastery `Config` 模式校验；无可调参数被硬编码。运行中的 profile 可通过 `cordis.patch.yml` 覆盖任意一项。

## Development

```sh
pnpm install
pnpm run typecheck        # 服务端源
pnpm run typecheck:client # 浏览器源（tsc）
pnpm test                 # vitest（store/project/asset/search/perf 套件）
pnpm run build            # tsdown → lib/
pnpm pack
```

### 性能契约

以下热点路径由回归测试钉住——review 看不出 100ms 与 1s 的差别，CI 跑过的数字才看得见：

| 契约 | 测试 |
|---|---|
| 持久化合并：100 次同步 `apply` → ≤2 次写入 | `tests/persistence-debounce.test.ts` |
| `postProcessCanvasPatch` 把 N 个视频节点合并成单次 `apply` | `tests/post-process-batching.test.ts` |
| 1000 次同步 `apply` 在 500ms 内完成且 ≤2 次写入 | `tests/perf-budget.test.ts` |
| 媒体文件名稳定（sha1 派生，16 位 hex） | `tests/stable-filename.test.ts` |
| `gcOrphanMedia` 只删不可达的 `v-` / `a-` / `i-` 文件 | `tests/orphan-gc.test.ts` |
| SSE 广播按 `canvasId` 分桶隔离 | `tests/sse-bucketing.test.ts` |
| merge token 在节点 data 未变时短路 | `tests/canvas-rerender-discipline.test.ts` |
| `loadAssetIndex` 命中 mtime 缓存（`Object.is` 稳定） | `tests/search-cache.test.ts` |
| `openProject` 只 restore 目标画布 | `tests/restore-target.test.ts` |
| `dependentsOf` / `scanAssetRefs` 不深拷贝画布 | `tests/dependents-no-clone.test.ts` |

任何改动热点路径（写入、SSE、媒体处理、依赖扫描、画布渲染）都必须随附对应的回归测试。

## 打赏支持

若这个插件帮到了你，欢迎用下面的二维码请我喝杯咖啡。

<table>
  <tr>
    <td align="center">
      <img src="https://raw.githubusercontent.com/xiaokaizhou/dsh-media-studio/main/.github/wechat-pay.jpg" width="180" alt="WeChat Pay"><br>
      <strong>微信支付</strong>
    </td>
    <td align="center">
      <img src="https://raw.githubusercontent.com/xiaokaizhou/dsh-media-studio/main/.github/alipay.jpg" width="180" alt="Alipay"><br>
      <strong>支付宝</strong>
    </td>
  </tr>
</table>

## License

[Apache License 2.0](LICENSE) © 2026 dsh-media-studio contributors.

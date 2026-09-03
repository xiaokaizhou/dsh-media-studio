# dsh-media-studio

一个 DeepSeek Harness（DSH）插件，为 agent 提供**多项目无限画布编辑器**：项目画布、每项目分门别类的素材库、全局实时素材搜索、跨项目软引用。媒体生成能力（`generate_image` / `generate_video` / `generate_music` / TTS）位于姊妹插件 `dsh-llm-multimodal`，本插件通过画布「重新生成」流程调用。

## Compatibility

| 项目 | 状态 |
|---|---|
| Harness | DeepSeek Harness `0.1.1-rc.2` |
| Node | `^22.19.0 || >=24.0.0` |
| 平台 | 全部（纯 ESM；无原生代码、无网络） |

## What it does

- **无限画布**（Media Studio 侧栏标签页，经 `betterSidebar`）。服务端权威 + SSE 实时回灌；键鼠编辑、撤销/重做、小地图、自动整理、媒体灯箱预览。
- **Agent 工具**（仅画布 4 个）：`canvas_graph_view`、`canvas_graph_patch`（原子批量 op，含 `batchAddMedia`）、`canvas_auto_arrange`、`canvas_refresh_node`。缺省 `canvasId` 解析为**当前激活项目**的画布。
- **项目（M0/M1）**：`projects.json` 注册表 + `<ws>/projects/<id>/assets/`；旧画布首次启动自动升级为项目。顶部「项目」菜单：新建 / 打开 / 最近打开（≤10）/ 重命名 / 删除（带依赖分析）；默认进 `<ws>/trash/` 回收站。
- **素材库（M2）**：四类资产（人物 / 场景 / 音频 / 视频片段）。画布媒体卡可「存入素材库」；素材库面板支持浏览、改名、跨项目复制、删除预检。资产文件名=资产 id——改名永不断引用。
- **全局搜索 + 软引用（M3）**：顶栏实时搜索（⌘K）对**全部项目**的库资产与完成画布素材做模糊匹配，按「当前项目 / 其他项目」分组。「+ 添加」把库资产**软引用**进当前画布（`data.assetRef`，不复制文件）；画布素材结果提供「复制入库」。引用关系支撑删除预检；源被删时可把被引用资产迁入共享库（`__shared`）或在引用处断链标记。
- **中英双语 UI**：极简 i18n，项目菜单内可切换（默认跟随浏览器语言）。

全部 REST/SSE 挂在 `/api/media-studio/*` 下（`projects*`、`assets*`、`refs`、`search`、`canvas/*`、`media-file` 代理、`projects/sse`）。

## Install

```sh
pnpm pack
dsh plugin --profile <name> add ./dsh-media-studio-0.3.0.tgz
dsh --profile <name> --dump-config | grep 'dsh-media-studio'
```

## Configuration

| 键 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `workspaceRoot` | string | `~/.media-studio` | 注册表、画布、项目素材、回收站所在 |
| `mediaRoots` | string[] | `[]` | media-file 代理可额外提供的目录 |
| `defaultCanvasId` | string | `main` | 兜底画布 id（激活项目优先） |
| `logToolCalls` | boolean | `true` | 工具结果写入会话日志 |
| `recentLimit` | number | `10` | 最近打开项目上限 |
| `trashEnabled` | boolean | `true` | 删除移入 `<ws>/trash`（除非显式彻底删除） |

配置由 `src/config.ts` 的 Schemastery `Config` 模式校验；无可调参数被硬编码。

## Development

```sh
pnpm install
pnpm run typecheck        # 服务端源
pnpm run typecheck:client # 浏览器源（tsc）
pnpm test                 # vitest（store/project/asset/search 套件）
pnpm run build            # tsdown → lib/
pnpm pack
```

## License

[Apache License 2.0](LICENSE) © 2026 dsh-media-studio contributors.

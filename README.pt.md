# dsh-media-studio

[![中文](https://img.shields.io/badge/语言-中文-blue)](./README.zh.md) [![English](https://img.shields.io/badge/language-English-lightgrey)](./README.md) [![npm](https://img.shields.io/npm/v/dsh-media-studio)](https://www.npmjs.com/package/dsh-media-studio)

Um plugin do DeepSeek Harness (DSH) que dá aos agentes um **editor de canvas infinito com múltiplos projetos**: storyboards em canvas, uma biblioteca de assets categorizada por projeto, busca global de assets em tempo real e referências suaves entre projetos. A geração de mídia pelo agente (`generate_image` / `generate_video` / `generate_music` / TTS / `generate_vision`) vive no plugin irmão `dsh-llm-multimodal` e é acessada a partir daqui pelos fluxos de "refresh" do canvas.

## Plugins complementares

Este plugin forma um ciclo completo **gerar → orquestrar → visualizar** com dois plugins irmãos do DSH, do mesmo autor. Instale-os juntos:

| Plugin | Papel | npm |
|---|---|---|
| [dsh-llm-multimodal](https://github.com/xiaokaizhou/dsh-llm-multimodal) | O backend de geração: `generate_image` / `generate_video` / `generate_vision` / `generate_tts` / `generate_music` / `generate_text`, descobertos automaticamente a partir de `llm-pi-ai` | [npm: dsh-llm-multimodal](https://www.npmjs.com/package/dsh-llm-multimodal) |
| [media-preview](https://github.com/xiaokaizhou/dsh-media-preview) | Renderiza caminhos de mídia locais/online no chat como pré-visualizações reproduzíveis (Range / cache / 27 formatos) | [npm: media-preview](https://www.npmjs.com/package/media-preview) |

- **Gerar → orquestrar**: este plugin publica o serviço cross-plugin `mediaStudio` (`ctx.reflect.provide`, referência suave — sem dependência rígida de nenhum dos lados). O `dsh-llm-multimodal` o lê via `ctx.get('mediaStudio')` e grava a mídia gerada diretamente em `<sourcePath>/assets/<kind>/` do projeto ativo, em vez de `/tmp`; os resultados carregam `projectId` + `canvasUrl`, que o `batchAddMedia` anexa aos nós do canvas. Quando este plugin está ausente, o gerador recorre à sua própria estratégia `outputDir` — a ordem de instalação não importa.
- **Orquestrar → visualizar**: arquivos de mídia gravados dentro de um projeto são servidos por `/api/media-studio/media-file`, enquanto o `media-preview` renderiza caminhos `file://` inline no chat.

## Compatibilidade

| Aspecto | Situação |
|---|---|
| Harness | DeepSeek Harness `0.1.1-rc.2` |
| Node | `^22.19.0 || >=24.0.0` |
| Plataformas | Todas (ESM puro; sem código nativo, sem rede) |

## O que ele faz

- **Canvas infinito** (aba lateral Media Studio, via `betterSidebar`). Estado com autoridade no servidor + atualizações ao vivo por SSE; edição por teclado/mouse, desfazer/refazer, minimapa, organização automática, pré-visualização de mídia/lightbox.
- **Ferramentas do agente (25)**: 13 `canvas_*` (visualizar/aplicar patch no grafo, organização automática, refresh de nó, CRUD de nó único, CRUD/ajuste de região) + 12 `media_studio_*` (gerenciamento de projetos, biblioteca de assets, busca global). Um `canvasId` em branco resolve para o canvas do **projeto ativo**.
- **Regiões**: caixas contêiner nomeadas que dividem o canvas em blocos (visão geral / roteiro / personagens / cenários / storyboard / mídia). Os nós pertencem a elas via `data.region`; as caixas crescem automaticamente conforme nós são adicionados e podem ser arrastadas, travadas e ajustadas ao seu conteúdo. `canvas_auto_arrange({ regionId })` reorganiza apenas aquela região.
- **Projetos (M0/M1)**: registro em `projects.json` + `assets/` por projeto; todo canvas legado é promovido automaticamente a projeto no primeiro boot. Menu "项目" da barra superior: novo / abrir / recentes (≤10) / renomear / excluir com análise de dependências; a exclusão vai para `<ws>/trash/` por padrão. Projetos criados com um `sourcePath` mantêm canvas e assets no diretório do próprio usuário.
- **Biblioteca de assets (M2)**: quatro categorias (personagens / cenários / áudio / clipes). Salve qualquer card de mídia do canvas na biblioteca; navegue, renomeie, copie entre projetos ou exclua com pré-verificação no painel de assets. O nome do arquivo de asset é o id do asset — renomear nunca quebra referências.
- **Busca global + referências suaves (M3)**: a busca ao vivo da barra superior (⌘K) faz correspondência difusa entre assets da biblioteca e mídias finalizadas no canvas de **todos** os projetos, agrupadas em projeto atual / outros projetos. "+ 添加" cria uma referência suave de um asset da biblioteca no canvas ativo (`data.assetRef` — nenhum arquivo é copiado); resultados de mídia do canvas recebem "复制入库". As referências são rastreadas para as pré-verificações de exclusão; ao excluir a origem, você pode migrar os assets referenciados para a biblioteca compartilhada (`__shared`) ou quebrar e marcar os nós que os referenciam.
- **UI zh/en**: i18n mínima; segue a configuração Language do DSH (`ctx.locale`).

Tudo é REST + SSE sob `/api/media-studio/*`: `projects*` (list/create/open/rename/delete/dependents/open-folder/pick-folder/reveal), `assets*` (list/register/update/delete/copy/dependents/sync-file), `refs`, `search`, `search/import-canvas`, `canvas/*` (state/patch/auto-arrange/refresh/backfill-video-posters), proxy `media-file`, `service-worker.js` e o endpoint unificado `sse`.

> **Uma única conexão SSE.** Patches de canvas e mudanças no registro (`registry-changed` / `project-open` / `project-deleted` / `asset-changed` / `project-focused`) são multiplexados em um único stream `/api/media-studio/sse`. Isso é proposital: o HTTP/1.1 limita um host a 6 conexões, e o núcleo do DSH já ocupa várias delas. A conexão é pausada enquanto a aba está oculta e sincroniza um snapshot novo após reconectar. Adicionar um segundo EventSource é uma regressão — mescle no endpoint existente.

## Instalação

```sh
# Option 1 (recommended): dsh CLI from the npm registry
dsh plugin --profile web add dsh-media-studio

# Option 2: from a packed tarball
pnpm pack
dsh plugin --profile <name> add ./dsh-media-studio-0.3.1.tgz

# verify the row mounted
dsh --profile <name> --dump-config | grep 'dsh-media-studio'
```

### Opcional: o agent preset media-studio

O pacote também inclui um agent preset (`src/presets/media-studio/agent.cordis.yml`) que dá a uma sessão uma persona de produção de mídia e as seções de prompt correspondentes. As ferramentas **não** são declaradas ali — a própria fiber do plugin já as registra, e toda sessão as herda por meio de `ctx.tools`. O preset acrescenta apenas identidade e enquadramento de prompt.

A partir de um checkout do código-fonte, `pnpm run prepare` (ou `bash scripts/setup-preset.sh [profile]`) cria um symlink dele em `$DSH_HOME/profiles/<profile>/agent-presets/media-studio/`. Em uma instalação via npm, crie o symlink você mesmo a partir de `node_modules/dsh-media-studio/src/presets/media-studio/agent.cordis.yml`. Depois selecione **media-studio** no seletor de agent preset, ou execute `/preset media-studio` no chat. Pular essa etapa por completo não tem problema — a aba do canvas e todas as 25 ferramentas funcionam sem ela.

## Configuração

| Chave | Tipo | Padrão | Descrição |
|---|---|---|---|
| `workspaceRoot` | string | `~/.media-studio` | Registro, canvas legados, lixeira |
| `mediaRoots` | string[] | `['~/Movies']` | Raízes extras que o proxy media-file pode servir. O padrão é `~/Movies` para que projetos de drama/filme criados com um `sourcePath` dentro dela renderizem sem nenhum ajuste. O `~` inicial é expandido |
| `defaultCanvasId` | string | `main` | Id de canvas de fallback (o projeto ativo tem precedência) |
| `logToolCalls` | boolean | `true` | Anexa os resultados das ferramentas ao log da sessão |
| `recentLimit` | number | `10` | Máximo de projetos "abertos recentemente" mantidos (1–50) |
| `trashEnabled` | boolean | `true` | As exclusões vão para `<ws>/trash`, a menos que sejam permanentes |

Validado pelo schema Schemastery `Config` em `src/config.ts`; nenhum parâmetro ajustável está fixo no código. Um profile em execução pode sobrescrever qualquer um deles através do seu `cordis.patch.yml`.

## Desenvolvimento

```sh
pnpm install
pnpm run typecheck        # server sources
pnpm run typecheck:client # browser sources (tsc)
pnpm test                 # vitest (store, project, asset, search, perf suites)
pnpm run build            # tsdown → lib/
pnpm pack
```

### Contratos de desempenho

Vários caminhos quentes são fixados por testes de regressão, porque uma diferença de 100 ms para 1 s é invisível na revisão, mas óbvia no CI:

| Contrato | Teste |
|---|---|
| A persistência é debounced — 100 chamadas `apply` síncronas → ≤2 gravações | `tests/persistence-debounce.test.ts` |
| `postProcessCanvasPatch` agrupa N nós de vídeo em um único `apply` | `tests/post-process-batching.test.ts` |
| 1000 chamadas `apply` síncronas terminam em <500 ms com ≤2 gravações | `tests/perf-budget.test.ts` |
| Nomes de arquivos de mídia são estáveis (derivados de sha1, 16 hex) | `tests/stable-filename.test.ts` |
| `gcOrphanMedia` exclui apenas arquivos `v-` / `a-` / `i-` inalcançáveis | `tests/orphan-gc.test.ts` |
| As transmissões SSE são agrupadas por `canvasId` | `tests/sse-bucketing.test.ts` |
| O merge token faz short-circuit quando os dados do nó não mudam | `tests/canvas-rerender-discipline.test.ts` |
| `loadAssetIndex` acerta seu cache de mtime (`Object.is` estável) | `tests/search-cache.test.ts` |
| `openProject` restaura apenas o canvas alvo | `tests/restore-target.test.ts` |
| `dependentsOf` / `scanAssetRefs` nunca fazem deep copy do canvas | `tests/dependents-no-clone.test.ts` |

Qualquer mudança em um caminho quente (gravações, SSE, processamento de mídia, varreduras de dependência, renderização do canvas) deve vir acompanhada de um teste de regressão correspondente.

## Patrocínio

Se este plugin economiza seu tempo, você pode me pagar um café com um dos QR codes abaixo.

<table>
  <tr>
    <td align="center">
      <img src="https://raw.githubusercontent.com/xiaokaizhou/dsh-media-studio/main/.github/wechat-pay.jpg" width="180" alt="WeChat Pay"><br>
      <strong>WeChat Pay</strong>
    </td>
    <td align="center">
      <img src="https://raw.githubusercontent.com/xiaokaizhou/dsh-media-studio/main/.github/alipay.jpg" width="180" alt="Alipay"><br>
      <strong>Alipay</strong>
    </td>
  </tr>
</table>

## Licença

Distribuído sob a [Apache License 2.0](LICENSE) © 2026 dsh-media-studio contributors.

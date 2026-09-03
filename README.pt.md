# dsh-media-studio

Um plugin do DeepSeek Harness (DSH) que dá aos agentes um **editor de tela infinita multiprojeto**: storyboards por projeto, uma biblioteca de ativos categorizada, pesquisa global em tempo real e referências suaves entre projetos. A geração de mídia (`generate_image` / `generate_video` / `generate_music` / TTS) vive no plugin irmão `dsh-llm-multimodal` e é alcançada daqui pelo fluxo de «regenerar» da tela.

## Compatibility

| Superfície | Estado |
|---|---|
| Harness | DeepSeek Harness `0.1.1-rc.2` |
| Node | `^22.19.0 || >=24.0.0` |
| Plataformas | Todas (ESM puro; sem código nativo, sem rede) |

## What it does

- **Tela infinita** (aba Media Studio via `betterSidebar`). Estado autoritativo no servidor + atualizações SSE; edição com teclado/rato, desfazer/refazer, minimapa, auto-organização, pré-visualização de mídia.
- **Ferramentas de agente** (apenas tela): `canvas_graph_view`, `canvas_graph_patch` (ops atómicas incl. `batchAddMedia`), `canvas_auto_arrange`, `canvas_refresh_node`. Um `canvasId` vazio resolve para a tela do **projeto ativo**.
- **Projetos (M0/M1)**: registro `projects.json` + `<ws>/projects/<id>/assets/`; cada tela legada vira projeto no primeiro arranque. Menu «Projeto»: novo / abrir / recentes (≤10) / renomear / excluir com análise de dependências; a exclusão vai para `<ws>/trash/` por padrão.
- **Biblioteca de ativos (M2)**: quatro categorias (personagens / cenas / áudio / clipes de vídeo). Salve qualquer cartão de mídia da tela na biblioteca; navegue/renomeie/copie para outro projeto/exclua com pré-verificação. Nomes de arquivo são ids de ativo — renomear nunca quebra referências.
- **Pesquisa global + referências suaves (M3)**: pesquisa ao vivo (⌘K) com correspondência difusa sobre bibliotecas e mídia de tela de **todos** os projetos, agrupada em projeto-atual / outros. «+ Adicionar» faz referência suave a um ativo na tela ativa (`data.assetRef`, sem copiar arquivo); resultados de tela oferecem «copiar para a biblioteca». As referências alimentam as pré-verificações de exclusão; ao excluir a fonte você pode migrar os ativos referenciados para a biblioteca compartilhada (`__shared`) ou quebrar/marcar os nós referenciantes.
- **UI zh/en**: i18n mínima; alternância no menu Projeto (idioma do navegador por padrão).

Tudo é REST + SSE sob `/api/media-studio/*` (`projects*`, `assets*`, `refs`, `search`, `canvas/*`, proxy `media-file`, `projects/sse`).

## Install

```sh
pnpm pack
dsh plugin --profile <name> add ./dsh-media-studio-0.3.0.tgz
dsh --profile <name> --dump-config | grep 'dsh-media-studio'
```

## Configuration

| Chave | Tipo | Padrão | Descrição |
|---|---|---|---|
| `workspaceRoot` | string | `~/.media-studio` | Registro, telas, pastas de ativos, lixeira |
| `mediaRoots` | string[] | `[]` | Raízes extras servidas pelo proxy media-file |
| `defaultCanvasId` | string | `main` | Tela de reserva (o projeto ativo manda) |
| `logToolCalls` | boolean | `true` | Acrescenta resultados de ferramentas ao log da sessão |
| `recentLimit` | number | `10` | Máx. de projetos recentes mantidos |
| `trashEnabled` | boolean | `true` | Exclusões vão para `<ws>/trash` exceto exclusão permanente |

Validado pelo esquema Schemastery `Config` em `src/config.ts`; nenhum parâmetro está fixado em código.

## Development

```sh
pnpm install
pnpm run typecheck        # fontes de servidor
pnpm run typecheck:client # fontes de navegador (tsc)
pnpm test                 # vitest (suites store/project/asset/search)
pnpm run build            # tsdown → lib/
pnpm pack
```

## License

[Apache License 2.0](LICENSE) © 2026 dsh-media-studio contributors.

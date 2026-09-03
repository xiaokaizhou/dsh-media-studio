# dsh-media-studio

Un plugin de DeepSeek Harness (DSH) que da a los agentes un **editor de lienzo infinito multiproyecto**: guiones gráficos por proyecto, una biblioteca de recursos categorizada, búsqueda global en tiempo real y referencias suaves entre proyectos. La generación de medios (`generate_image` / `generate_video` / `generate_music` / TTS) vive en el plugin hermano `dsh-llm-multimodal` y se alcanza desde aquí vía el flujo de «regenerar» del lienzo.

## Compatibility

| Superficie | Estado |
|---|---|
| Harness | DeepSeek Harness `0.1.1-rc.2` |
| Node | `^22.19.0 || >=24.0.0` |
| Plataformas | Todas (ESM puro; sin código nativo, sin red) |

## What it does

- **Lienzo infinito** (pestaña Media Studio vía `betterSidebar`). Estado autoritativo en servidor + actualizaciones SSE; edición con teclado/ratón, deshacer/rehacer, minimapa, auto-orden, previsualización de medios.
- **Herramientas de agente** (solo lienzo): `canvas_graph_view`, `canvas_graph_patch` (ops atómicas incl. `batchAddMedia`), `canvas_auto_arrange`, `canvas_refresh_node`. Un `canvasId` vacío se resuelve al lienzo del **proyecto activo**.
- **Proyectos (M0/M1)**: registro `projects.json` + `<ws>/projects/<id>/assets/`; cada lienzo heredado se promueve a proyecto al primer arranque. Menú «Proyecto»: nuevo / abrir / recientes (≤10) / renombrar / eliminar con análisis de dependencias; el borrado va a `<ws>/trash/` por defecto.
- **Biblioteca de recursos (M2)**: cuatro categorías (personajes / escenas / audio / clips de vídeo). Guarda cualquier tarjeta de medios del lienzo en la biblioteca; navega/renombra/copia a otro proyecto/elimina con precomprobación. Los nombres de archivo son ids de recurso — renombrar nunca rompe referencias.
- **Búsqueda global + referencias suaves (M3)**: búsqueda en vivo (⌘K) con coincidencia difusa sobre bibliotecas y medios de lienzo de **todos** los proyectos, agrupada en proyecto-actual / otros. «+ Añadir» referencia suavemente un recurso en el lienzo activo (`data.assetRef`, sin copiar archivo); los resultados de lienzo ofrecen «copiar a la biblioteca». Las referencias alimentan las precomprobaciones de borrado; al borrar la fuente puede migrar los recursos referenciados a la biblioteca compartida (`__shared`) o romper/marcar los nodos referenciantes.
- **UI zh/en**: i18n mínima; conmutador en el menú Proyecto (idioma del navegador por defecto).

Todo es REST + SSE bajo `/api/media-studio/*` (`projects*`, `assets*`, `refs`, `search`, `canvas/*`, proxy `media-file`, `projects/sse`).

## Install

```sh
pnpm pack
dsh plugin --profile <name> add ./dsh-media-studio-0.3.0.tgz
dsh --profile <name> --dump-config | grep 'dsh-media-studio'
```

## Configuration

| Clave | Tipo | Por defecto | Descripción |
|---|---|---|---|
| `workspaceRoot` | string | `~/.media-studio` | Registro, lienzos, carpetas de recursos, papelera |
| `mediaRoots` | string[] | `[]` | Raíces extra servidas por el proxy media-file |
| `defaultCanvasId` | string | `main` | Lienzo de reserva (el proyecto activo manda) |
| `logToolCalls` | boolean | `true` | Añade resultados de herramientas al log de sesión |
| `recentLimit` | number | `10` | Máx. de proyectos recientes conservados |
| `trashEnabled` | boolean | `true` | Los borrados van a `<ws>/trash` salvo borrado permanente |

Validado por el esquema Schemastery `Config` en `src/config.ts`; ningún parámetro está fijado en código.

## Development

```sh
pnpm install
pnpm run typecheck        # fuentes de servidor
pnpm run typecheck:client # fuentes de navegador (tsc)
pnpm test                 # vitest (suites store/project/asset/search)
pnpm run build            # tsdown → lib/
pnpm pack
```

## License

[Apache License 2.0](LICENSE) © 2026 dsh-media-studio contributors.

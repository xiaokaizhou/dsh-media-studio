# dsh-media-studio

[![中文](https://img.shields.io/badge/语言-中文-blue)](./README.zh.md) [![English](https://img.shields.io/badge/language-English-lightgrey)](./README.md) [![npm](https://img.shields.io/npm/v/dsh-media-studio)](https://www.npmjs.com/package/dsh-media-studio)

Un plugin de DeepSeek Harness (DSH) que dota a los agentes de un **editor de lienzo infinito multiproyecto**: storyboards en lienzo, una biblioteca de recursos categorizada por proyecto, búsqueda global de recursos en tiempo real y referencias blandas entre proyectos. La generación de medios por parte del agente (`generate_image` / `generate_video` / `generate_music` / TTS / `generate_vision`) reside en el plugin hermano `dsh-llm-multimodal` y se alcanza desde aquí a través de los flujos "refresh" del lienzo.

## Pensado para la producción de vídeo con IA

El lienzo es la mesa de producción para trabajo de vídeo con IA de varios planos y recorrido largo: el tipo de proyecto que necesita personajes coherentes, activos reutilizables y una topología plano a plano, no un único prompt:

| Caso de uso | Qué aporta el lienzo |
|---|---|
| **AI comic drama (漫剧)** | Una región por episodio: los bloques de activos de personaje y escena se reutilizan entre planos, y un nodo compartido de estilo artístico alimenta todos los prompts posteriores para que el look se mantenga a lo largo de decenas de viñetas |
| **AI micro film (微电影)** | Las regiones guion → storyboard → plano → montaje hacen que el estado del film completo sea auditable de un vistazo; el encadenado de fotogramas clave inicial/final mantiene continuos los planos consecutivos en lugar de parecer diapositivas |
| **AI video creation (视频创作)** | Cualquier pieza de varios planos: anuncios de producto, videoclips, explicativos. `canvas_refresh_node` a nivel de nodo regenera solo el plano que falló, sin rehacer el resto del tablero |

Las funciones de abajo son las que hacen esto practicable: una **biblioteca de activos** por proyecto (personajes / escenas / audio / clips) mantiene coherente al protagonista, las **referencias blandas** permiten que un activo de personaje sirva a muchos lienzos sin copiar archivos, y la **búsqueda global (⌘K)** encuentra un activo de escena de un proyecto antiguo para reutilizarlo en el actual.

## Plugins complementarios

Este plugin forma un ciclo completo **generar → orquestar → previsualizar** junto con dos plugins hermanos de DSH del mismo autor. Instálalos en conjunto:

| Plugin | Rol | npm |
|---|---|---|
| [dsh-llm-multimodal](https://github.com/xiaokaizhou/dsh-llm-multimodal) | El backend de generación: `generate_image` / `generate_video` / `generate_vision` / `generate_tts` / `generate_music` / `generate_text`, autodescubierto desde `llm-pi-ai` | [npm: dsh-llm-multimodal](https://www.npmjs.com/package/dsh-llm-multimodal) |
| [media-preview](https://github.com/xiaokaizhou/dsh-media-preview) | Renderiza rutas de medios locales o en línea dentro del chat como vistas previas reproducibles (Range / caché / 27 formatos) | [npm: media-preview](https://www.npmjs.com/package/media-preview) |

- **Generar → orquestar**: este plugin publica el servicio entre plugins `mediaStudio` (`ctx.reflect.provide`, referencia blanda — sin dependencia dura en ninguno de los dos sentidos). `dsh-llm-multimodal` lo lee mediante `ctx.get('mediaStudio')` y escribe los medios generados directamente en `<sourcePath>/assets/<kind>/` del proyecto activo en lugar de en `/tmp`; los resultados incluyen `projectId` + `canvasUrl`, que `batchAddMedia` adjunta a los nodos del lienzo. Cuando este plugin no está presente, el generador recurre a su propia estrategia `outputDir`; el orden de instalación no importa.
- **Orquestar → previsualizar**: los archivos de medios escritos dentro de un proyecto se sirven a través de `/api/media-studio/media-file`, mientras que `media-preview` renderiza las rutas `file://` directamente en el chat.

## Compatibilidad

| Superficie | Estado |
|---|---|
| Harness | DeepSeek Harness `0.1.1-rc.2` |
| Node | `^22.19.0 || >=24.0.0` |
| Plataformas | Todas (ESM puro; sin código nativo ni red) |

## Qué hace

- **Lienzo infinito** (pestaña lateral Media Studio, mediante `betterSidebar`). Estado con autoridad en el servidor + actualizaciones en vivo por SSE; edición con teclado y ratón, deshacer/rehacer, minimapa, organización automática, vista previa de medios y lightbox.
- **Herramientas del agente (25)**: 13 `canvas_*` (vista y parche del grafo, organización automática, refresco de nodos, CRUD de un solo nodo, CRUD y ajuste de regiones) + 12 `media_studio_*` (gestión de proyectos, biblioteca de recursos, búsqueda global). Un `canvasId` vacío se resuelve al lienzo del **proyecto activo**.
- **Regiones**: cajas contenedoras con nombre que dividen el lienzo en bloques (visión general / guion / personajes / escenas / storyboard / medios). Los nodos pertenecen a una región a través de `data.region`; las cajas crecen automáticamente a medida que se añaden nodos y se pueden arrastrar, bloquear y ajustar a su contenido. `canvas_auto_arrange({ regionId })` reorganiza únicamente esa región.
- **Proyectos (M0/M1)**: registro `projects.json` + `assets/` por proyecto; todo lienzo heredado se promueve automáticamente a proyecto en el primer arranque. Menú "项目" de la barra superior: nuevo / abrir / recientes (≤10) / renombrar / eliminar con análisis de dependencias; de forma predeterminada la eliminación va a `<ws>/trash/`. Los proyectos creados con un `sourcePath` conservan su lienzo y sus recursos en el directorio del propio usuario.
- **Biblioteca de recursos (M2)**: cuatro categorías (personajes / escenas / audio / clips). Guarda cualquier tarjeta de medios del lienzo en la biblioteca; examina, renombra, copia a otro proyecto o elimina con verificación previa desde el panel de recursos. Los nombres de archivo de los recursos son los propios ids de recurso, así que renombrar nunca rompe una referencia.
- **Búsqueda global + referencias blandas (M3)**: búsqueda en vivo en la barra superior (⌘K) que hace coincidencia difusa entre los recursos de la biblioteca y los medios ya terminados del lienzo de **todos** los proyectos, agrupados en proyecto actual / otros proyectos. "+ 添加" crea una referencia blanda de un recurso de la biblioteca en el lienzo activo (`data.assetRef`, sin copiar ningún archivo); los resultados de medios del lienzo ofrecen "复制入库". Las referencias se rastrean para las verificaciones previas de borrado; al eliminar el origen puedes migrar los recursos referenciados a la biblioteca compartida (`__shared`) o romper las referencias y marcar los nodos afectados.
- **Interfaz zh/en**: i18n mínima; sigue el ajuste Language de DSH (`ctx.locale`).

Todo es REST + SSE bajo `/api/media-studio/*`: `projects*` (list/create/open/rename/delete/dependents/open-folder/pick-folder/reveal), `assets*` (list/register/update/delete/copy/dependents/sync-file), `refs`, `search`, `search/import-canvas`, `canvas/*` (state/patch/auto-arrange/refresh/backfill-video-posters), el proxy `media-file`, `service-worker.js` y el endpoint unificado `sse`.

> **Una sola conexión SSE.** Los parches del lienzo y los cambios del registro (`registry-changed` / `project-open` / `project-deleted` / `asset-changed` / `project-focused`) se multiplexan sobre un único flujo `/api/media-studio/sse`. Es deliberado: HTTP/1.1 limita un host a 6 conexiones y el núcleo de DSH ya ocupa varias. La conexión se pausa mientras la pestaña está oculta y sincroniza una instantánea nueva tras reconectar. Añadir un segundo EventSource es una regresión: en su lugar, fusiona el evento en este endpoint.

## Instalación

```sh
# Option 1 (recommended): dsh CLI from the npm registry
dsh plugin --profile web add dsh-media-studio

# Option 2: from a packed tarball
pnpm pack
dsh plugin --profile <name> add ./dsh-media-studio-0.3.1.tgz

# verify the row mounted
dsh --profile <name> --dump-config | grep 'dsh-media-studio'
```

### Opcional: el preset de agente media-studio

El paquete también incluye un preset de agente (`src/presets/media-studio/agent.cordis.yml`) que dota a una sesión de una persona de producción de medios y de las secciones de prompt correspondientes. Las herramientas **no** se declaran ahí: la propia fiber del plugin ya las registra, y toda sesión las hereda a través de `ctx.tools`. El preset solo añade identidad y encuadre de prompt.

Desde un checkout del código fuente, `pnpm run prepare` (o `bash scripts/setup-preset.sh [profile]`) lo enlaza simbólicamente en `$DSH_HOME/profiles/<profile>/agent-presets/media-studio/`. Desde una instalación de npm, enlázalo tú mismo desde `node_modules/dsh-media-studio/src/presets/media-studio/agent.cordis.yml`. Después elige **media-studio** en el selector de presets de agente, o ejecuta `/preset media-studio` en el chat. Omitir este paso por completo no supone ningún problema: la pestaña del lienzo y las 25 herramientas funcionan sin él.

## Configuración

| Clave | Tipo | Valor predeterminado | Descripción |
|---|---|---|---|
| `workspaceRoot` | string | `~/.media-studio` | Registro, lienzos heredados, papelera |
| `mediaRoots` | string[] | `['~/Movies']` | Raíces adicionales que el proxy media-file puede servir. El valor predeterminado es `~/Movies` para que los proyectos de drama o cine creados con un `sourcePath` bajo esa ruta se rendericen sin configuración adicional. El `~` inicial se expande |
| `defaultCanvasId` | string | `main` | Id de lienzo de reserva (el proyecto activo tiene prioridad) |
| `logToolCalls` | boolean | `true` | Añade los resultados de las herramientas al registro de la sesión |
| `recentLimit` | number | `10` | Número máximo de proyectos "abiertos recientemente" que se conservan (1–50) |
| `trashEnabled` | boolean | `true` | Las eliminaciones van a `<ws>/trash` salvo que sean permanentes |

Validado por el esquema Schemastery `Config` de `src/config.ts`; ningún valor ajustable está codificado de forma fija. Un perfil en ejecución puede sobrescribir cualquiera de estos valores a través de su `cordis.patch.yml`.

## Desarrollo

```sh
pnpm install
pnpm run typecheck        # server sources
pnpm run typecheck:client # browser sources (tsc)
pnpm test                 # vitest (store, project, asset, search, perf suites)
pnpm run build            # tsdown → lib/
pnpm pack
```

### Contratos de rendimiento

Varias rutas críticas están fijadas por pruebas de regresión, porque una diferencia de 100 ms frente a 1 s es invisible en una revisión pero evidente en CI:

| Contrato | Prueba |
|---|---|
| La persistencia está amortiguada (debounce) — 100 llamadas síncronas a `apply` → ≤2 escrituras | `tests/persistence-debounce.test.ts` |
| `postProcessCanvasPatch` agrupa N nodos de vídeo en un único `apply` | `tests/post-process-batching.test.ts` |
| 1000 llamadas síncronas a `apply` terminan en <500 ms con ≤2 escrituras | `tests/perf-budget.test.ts` |
| Los nombres de archivo de medios son estables (derivados de sha1, 16 hex) | `tests/stable-filename.test.ts` |
| `gcOrphanMedia` solo elimina archivos `v-` / `a-` / `i-` inalcanzables | `tests/orphan-gc.test.ts` |
| Las difusiones SSE se agrupan por `canvasId` | `tests/sse-bucketing.test.ts` |
| El token de fusión cortocircuita cuando los datos del nodo no cambian | `tests/canvas-rerender-discipline.test.ts` |
| `loadAssetIndex` acierta en su caché de mtime (`Object.is` estable) | `tests/search-cache.test.ts` |
| `openProject` restaura únicamente el lienzo de destino | `tests/restore-target.test.ts` |
| `dependentsOf` / `scanAssetRefs` nunca copian el lienzo en profundidad | `tests/dependents-no-clone.test.ts` |

Cualquier cambio en una ruta crítica (escrituras, SSE, procesamiento de medios, escaneos de dependencias, renderizado del lienzo) debe entregarse junto con una prueba de regresión correspondiente.

## Patrocinio

Si este plugin te ahorra tiempo, puedes invitarme a un café con uno de los siguientes códigos QR.

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

## Licencia

[Apache License 2.0](LICENSE) © 2026 dsh-media-studio contributors.

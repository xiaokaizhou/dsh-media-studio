# dsh-media-studio

[![中文](https://img.shields.io/badge/语言-中文-blue)](./README.zh.md) [![English](https://img.shields.io/badge/language-English-lightgrey)](./README.md) [![npm](https://img.shields.io/npm/v/dsh-media-studio)](https://www.npmjs.com/package/dsh-media-studio)

एक DeepSeek Harness (DSH) प्लगइन जो agents को **मल्टी-प्रोजेक्ट इनफ़िनिट कैनवास एडिटर** देता है: कैनवास स्टोरीबोर्ड, हर प्रोजेक्ट के लिए श्रेणीबद्ध asset library, ग्लोबल रियल-टाइम asset search, और प्रोजेक्ट्स के बीच soft references। Agent की media generation (`generate_image` / `generate_video` / `generate_music` / TTS / `generate_vision`) साथी प्लगइन `dsh-llm-multimodal` में रहती है और यहाँ से कैनवास के "refresh" flows के ज़रिए पहुँचती है।

## AI वीडियो निर्माण के लिए बनाया गया

यह canvas कई shots वाले लंबे AI वीडियो काम के लिए production board है — ऐसे प्रोजेक्ट के लिए जिनमें एक जैसे पात्र, दोबारा इस्तेमाल होने वाले assets और shot-by-shot topology चाहिए, न कि सिर्फ़ एक prompt:

| उपयोग | canvas क्या देता है |
|---|---|
| **AI comic drama (漫剧)** | हर episode के लिए एक region: character/scene asset blocks shots के बीच दोबारा काम आते हैं, और एक साझा art-style node नीचे के सभी prompts को feed करता है, जिससे दर्जनों panels में look एक जैसा रहता है |
| **AI micro film (微电影)** | script → storyboard → shot → edit regions से पूरी फ़िल्म की स्थिति एक नज़र में जाँची जा सकती है; first/last-frame keyframe chaining लगातार shots को जोड़े रखती है, slides जैसा नहीं बनने देती |
| **AI video creation (视频创作)** | कोई भी multi-shot काम — product ads, MV, explainers। node-स्तर का `canvas_refresh_node` सिर्फ़ उसी shot को दोबारा बनाता है जो खराब आया, पूरा board दोबारा नहीं करना पड़ता |

नीचे दी गई सुविधाएँ इसे व्यवहारिक बनाती हैं: हर प्रोजेक्ट की **asset library** (characters / scenes / audio / clips) मुख्य पात्र को एक जैसा रखती है, **soft references** से एक character asset कई canvases में बिना फ़ाइल कॉपी किए काम आता है, और **global search (⌘K)** पुराने प्रोजेक्ट से scene asset ढूँढकर मौजूदा canvas में ले आता है।

## साथी प्लगइन

यह प्लगइन उसी लेखक के दो साथी DSH प्लगइन्स के साथ एक पूरा **generate → orchestrate → preview** लूप बनाता है। इन्हें साथ में इंस्टॉल करें:

| प्लगइन | भूमिका | npm |
|---|---|---|
| [dsh-llm-multimodal](https://github.com/xiaokaizhou/dsh-llm-multimodal) | Generation backend: `generate_image` / `generate_video` / `generate_vision` / `generate_tts` / `generate_music` / `generate_text`, जो `llm-pi-ai` से अपने आप discover होते हैं | [npm: dsh-llm-multimodal](https://www.npmjs.com/package/dsh-llm-multimodal) |
| [media-preview](https://github.com/xiaokaizhou/dsh-media-preview) | चैट में local/online media paths को चलने योग्य previews के रूप में रेंडर करता है (Range / caching / 27 formats) | [npm: media-preview](https://www.npmjs.com/package/media-preview) |

- **Generate → orchestrate**: यह प्लगइन cross-plugin `mediaStudio` service प्रकाशित करता है (`ctx.reflect.provide`, soft reference — किसी भी तरफ़ hard dependency नहीं)। `dsh-llm-multimodal` इसे `ctx.get('mediaStudio')` से पढ़ता है और generate हुई media को `/tmp` के बजाय सीधे active project के `<sourcePath>/assets/<kind>/` में लिखता है; results के साथ `projectId` + `canvasUrl` आते हैं, जिन्हें `batchAddMedia` कैनवास nodes पर अटैच करता है। यह प्लगइन मौजूद न हो तो generator अपनी `outputDir` strategy पर लौट जाता है — install का क्रम मायने नहीं रखता।
- **Orchestrate → preview**: किसी प्रोजेक्ट के अंदर लिखी media files `/api/media-studio/media-file` के ज़रिए serve होती हैं, जबकि `media-preview` चैट में `file://` paths को inline रेंडर करता है।

## Compatibility

| सतह | स्थिति |
|---|---|
| Harness | DeepSeek Harness `0.1.1-rc.2` |
| Node | `^22.19.0 || >=24.0.0` |
| प्लेटफ़ॉर्म | सभी (plain ESM; कोई native code नहीं, कोई network नहीं) |

## What it does

- **इनफ़िनिट कैनवास** (Media Studio साइडबार टैब, `betterSidebar` के ज़रिए)। Server-authoritative state + SSE live updates; keyboard/mouse editing, undo/redo, minimap, auto-arrange, media preview/lightbox।
- **Agent tools (25)**: 13 `canvas_*` (graph view/patch, auto-arrange, node refresh, single-node CRUD, region CRUD/fit) + 12 `media_studio_*` (project management, asset library, global search)। खाली `canvasId` **active project** के कैनवास पर resolve होता है।
- **Regions**: नामित container boxes जो कैनवास को blocks में बाँटते हैं (overview / script / characters / scenes / storyboard / media)। Nodes `data.region` के ज़रिए इनसे जुड़ते हैं; nodes जुड़ने पर boxes अपने आप बढ़ते जाते हैं और इन्हें drag, lock तथा contents के हिसाब से fit किया जा सकता है। `canvas_auto_arrange({ regionId })` सिर्फ़ उसी region को दोबारा व्यवस्थित करता है।
- **Projects (M0/M1)**: `projects.json` registry + हर प्रोजेक्ट के लिए `assets/`; पहले boot पर हर legacy canvas अपने आप project में promote हो जाता है। टॉप बार का "项目" मेन्यू: new / open / recent (≤10) / rename / delete, dependency analysis के साथ; default में deletion `<ws>/trash/` में जाती है। `sourcePath` के साथ बनाए गए projects अपना canvas और assets उपयोगकर्ता की अपनी directory में रखते हैं।
- **Asset library (M2)**: चार श्रेणियाँ (characters / scenes / audio / clips)। किसी भी canvas media card को library में सेव करें; asset panel में browse / rename / copy-to-project / delete-with-preflight करें। Asset file names ही asset ids होते हैं — rename करने पर references कभी नहीं टूटते।
- **Global search + soft references (M3)**: टॉप-बार live search (⌘K) **सभी** projects के library assets और तैयार canvas media पर fuzzy match करता है और नतीजों को current-project / other-projects में बाँटता है। "+ 添加" किसी library asset को active canvas में soft-reference करता है (`data.assetRef` — कोई फ़ाइल कॉपी नहीं होती); canvas-media नतीजों पर "复制入库" मिलता है। Deletion preflights के लिए references track होते हैं; source delete होने पर आप referenced assets को shared library (`__shared`) में migrate कर सकते हैं या referencing nodes को break-and-mark कर सकते हैं।
- **zh/en UI**: न्यूनतम i18n; DSH की Language setting (`ctx.locale`) का पालन करता है।

सब कुछ `/api/media-studio/*` के अंतर्गत REST + SSE है: `projects*` (list/create/open/rename/delete/dependents/open-folder/pick-folder/reveal), `assets*` (list/register/update/delete/copy/dependents/sync-file), `refs`, `search`, `search/import-canvas`, `canvas/*` (state/patch/auto-arrange/refresh/backfill-video-posters), `media-file` proxy, `service-worker.js`, और एकीकृत `sse` endpoint।

> **सिर्फ़ एक SSE connection।** Canvas patches और registry changes (`registry-changed` / `project-open` / `project-deleted` / `asset-changed` / `project-focused`) एक ही `/api/media-studio/sse` stream पर multiplex होते हैं। यह जानबूझकर ऐसा है: HTTP/1.1 किसी host पर 6 connections की सीमा लगाता है, और DSH core पहले से कई connections रखता है। टैब छिपा होने पर connection pause रहता है और reconnect के बाद ताज़ा snapshot sync हो जाता है। दूसरा EventSource जोड़ना regression है — इसके बजाय इसी endpoint में merge करें।

## Install

```sh
# Option 1 (recommended): dsh CLI from the npm registry
dsh plugin --profile web add dsh-media-studio

# Option 2: from a packed tarball
pnpm pack
dsh plugin --profile <name> add ./dsh-media-studio-0.3.1.tgz

# verify the row mounted
dsh --profile <name> --dump-config | grep 'dsh-media-studio'
```

### वैकल्पिक: media-studio agent preset

यह package एक agent preset भी भेजता है (`src/presets/media-studio/agent.cordis.yml`), जो किसी session को media-production persona और उससे मेल खाते prompt sections देता है। इसमें tools **declare नहीं** किए जाते — प्लगइन का अपना fiber उन्हें पहले ही register कर देता है, और हर session उन्हें `ctx.tools` के ज़रिए inherit करता है। Preset सिर्फ़ identity और prompt framing जोड़ता है।

Source checkout से `pnpm run prepare` (या `bash scripts/setup-preset.sh [profile]`) इसे `$DSH_HOME/profiles/<profile>/agent-presets/media-studio/` में symlink कर देता है। npm install के मामले में इसे आप खुद `node_modules/dsh-media-studio/src/presets/media-studio/agent.cordis.yml` से symlink करें। फिर agent preset selector में **media-studio** चुनें, या चैट में `/preset media-studio` चलाएँ। इस step को पूरी तरह छोड़ देना भी ठीक है — canvas tab और सभी 25 tools इसके बिना भी काम करते हैं।

## Configuration

| कुंजी | प्रकार | डिफ़ॉल्ट | विवरण |
|---|---|---|---|
| `workspaceRoot` | string | `~/.media-studio` | Registry, legacy canvases, trash |
| `mediaRoots` | string[] | `['~/Movies']` | वे अतिरिक्त roots जिन्हें media-file proxy serve कर सकता है। डिफ़ॉल्ट `~/Movies` है ताकि उसके नीचे `sourcePath` के साथ बनाए गए drama/film projects बिना किसी अतिरिक्त सेटअप के render हो जाएँ। शुरू का `~` expand हो जाता है |
| `defaultCanvasId` | string | `main` | Fallback canvas id (active project की प्राथमिकता रहती है) |
| `logToolCalls` | boolean | `true` | Tool results को session log में जोड़ता है |
| `recentLimit` | number | `10` | रखे जाने वाले "recently opened" projects की अधिकतम संख्या (1–50) |
| `trashEnabled` | boolean | `true` | permanent न होने पर deletions `<ws>/trash` में जाती हैं |

`src/config.ts` में Schemastery `Config` schema से validate होता है; कोई भी tunable hardcode नहीं है। चल रहा profile इनमें से कोई भी चीज़ अपने `cordis.patch.yml` के ज़रिए override कर सकता है।

## Development

```sh
pnpm install
pnpm run typecheck        # server sources
pnpm run typecheck:client # browser sources (tsc)
pnpm test                 # vitest (store, project, asset, search, perf suites)
pnpm run build            # tsdown → lib/
pnpm pack
```

### परफ़ॉर्मेंस कॉन्ट्रैक्ट्स

कई hot paths regression tests से पिन किए गए हैं, क्योंकि 100 ms और 1 s का फ़र्क़ review में नहीं दिखता, पर CI में साफ़ पकड़ में आता है:

| कॉन्ट्रैक्ट | टेस्ट |
|---|---|
| Persist debounced है — 100 sync `apply` calls → ≤2 writes | `tests/persistence-debounce.test.ts` |
| `postProcessCanvasPatch` N video nodes को एक ही `apply` में batch करता है | `tests/post-process-batching.test.ts` |
| 1000 sync `apply` calls <500 ms में पूरे होते हैं, ≤2 writes के साथ | `tests/perf-budget.test.ts` |
| Media file names स्थिर रहते हैं (sha1-derived, 16-hex) | `tests/stable-filename.test.ts` |
| `gcOrphanMedia` सिर्फ़ unreachable `v-` / `a-` / `i-` files हटाता है | `tests/orphan-gc.test.ts` |
| SSE broadcasts हर `canvasId` के हिसाब से bucket किए जाते हैं | `tests/sse-bucketing.test.ts` |
| Merge token बिना बदले node data पर short-circuit होता है | `tests/canvas-rerender-discipline.test.ts` |
| `loadAssetIndex` अपने mtime cache पर hit करता है (`Object.is` stable) | `tests/search-cache.test.ts` |
| `openProject` सिर्फ़ target canvas restore करता है | `tests/restore-target.test.ts` |
| `dependentsOf` / `scanAssetRefs` कैनवास की deep-copy कभी नहीं करते | `tests/dependents-no-clone.test.ts` |

किसी भी hot path (writes, SSE, media processing, dependency scans, canvas rendering) में किया गया बदलाव उससे मेल खाते regression test के साथ ही भेजा जाना चाहिए।

## स्पॉन्सरशिप

अगर यह plugin आपका समय बचाता है, तो नीचे दिए गए QR कोड में से किसी एक से मुझे एक कॉफी दिला सकते हैं।

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

## License

[Apache License 2.0](LICENSE) © 2026 dsh-media-studio contributors.

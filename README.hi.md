# dsh-media-studio

एक DeepSeek Harness (DSH) प्लगइन जो एजेंटों को **मल्टी-प्रोजेक्ट अनंत कैनवास एडिटर** देता है: प्रोजेक्ट स्टोरीबोर्ड, प्रति प्रोजेक्ट श्रेणीबद्ध एसेट लाइब्रेरी, वैश्विक रीयल-टाइम एसेट खोज, और प्रोजेक्टों के बीच सॉफ्ट संदर्भ (soft references)। मीडिया जनरेशन (`generate_image` / `generate_video` / `generate_music` / TTS) सहोदर प्लगइन `dsh-llm-multimodal` में रहता है और यहाँ से कैनवास के «regenerate» प्रवाह द्वारा पहुँचा जाता है।

## Compatibility

| सतह | स्थिति |
|---|---|
| Harness | DeepSeek Harness `0.1.1-rc.2` |
| Node | `^22.19.0 || >=24.0.0` |
| प्लेटफ़ॉर्म | सभी (शुद्ध ESM; कोई नेटिव कोड नहीं, कोई नेटवर्क नहीं) |

## What it does

- **अनंत कैनवास** (`betterSidebar` से Media Studio टैब)। सर्वर-प्राधिकृत स्थिति + SSE लाइव अपडेट; कीबोर्ड/माउस संपादन, undo/redo, minimap, auto-arrange, मीडिया प्रीव्यू।
- **एजेंट टूल** (केवल कैनवास): `canvas_graph_view`, `canvas_graph_patch` (परमाणु बैच ops, `batchAddMedia` सहित), `canvas_auto_arrange`, `canvas_refresh_node`। खाली `canvasId` **सक्रिय प्रोजेक्ट** के कैनवास पर हल होता है।
- **प्रोजेक्ट (M0/M1)**: `projects.json` रजिस्ट्री + `<ws>/projects/<id>/assets/`; पहले बूट पर हर लेगेसी कैनवास प्रोजेक्ट बन जाता है। «प्रोजेक्ट» मेन्यू: नया / खोलें / हाल के (≤10) / नाम बदलें / निर्भरता विश्लेषण के साथ हटाएँ; हटाना डिफ़ॉल्ट रूप से `<ws>/trash/` में जाता है।
- **एसेट लाइब्रेरी (M2)**: चार श्रेणियाँ (किरदार / दृश्य / ऑडियो / वीडियो क्लिप)। किसी भी मीडिया कार्ड को लाइब्रेरी में सहेजें; पैनल में ब्राउज़/नाम बदलें/कॉपी/प्री-चेक के साथ हटाएँ। फ़ाइल नाम एसेट id होते हैं — नाम बदलने से संदर्भ कभी नहीं टूटते।
- **वैश्विक खोज + सॉफ्ट संदर्भ (M3)**: टॉप-बार लाइव खोज (⌘K) सभी प्रोजेक्टों की लाइब्रेरी व कैनवास मीडिया पर फ़ज़ी मिलान करती है, «वर्तमान / अन्य प्रोजेक्ट» समूहों में। «+ जोड़ें» किसी एसेट को सक्रिय कैनवास में सॉफ्ट-संदर्भित करता है (`data.assetRef`, फ़ाइल कॉपी नहीं); कैनवास परिणाम «लाइब्रेरी में कॉपी» देते हैं। हटाने की प्री-जाँच संदर्भों का उपयोग करती है; स्रोत हटाते समय संदर्भित एसेट साझा लाइब्रेरी (`__shared`) में माइग्रेट कर सकते हैं या संदर्भित नोड्स को तोड़/चिह्नित कर सकते हैं।
- **zh/en UI**: न्यूनतम i18n; प्रोजेक्ट मेन्यू में टॉगल (डिफ़ॉल्ट ब्राउज़र भाषा)।

सब कुछ `/api/media-studio/*` के अंतर्गत REST + SSE है (`projects*`, `assets*`, `refs`, `search`, `canvas/*`, `media-file` proxy, `projects/sse`).

## Install

```sh
pnpm pack
dsh plugin --profile <name> add ./dsh-media-studio-0.3.0.tgz
dsh --profile <name> --dump-config | grep 'dsh-media-studio'
```

## Configuration

| कुंजी | प्रकार | डिफ़ॉल्ट | विवरण |
|---|---|---|---|
| `workspaceRoot` | string | `~/.media-studio` | रजिस्ट्री, कैनवस, एसेट फ़ोल्डर, कचरा |
| `mediaRoots` | string[] | `[]` | media-file proxy द्वारा दी जाने वाली अतिरिक्त जड़ें |
| `defaultCanvasId` | string | `main` | फ़ॉलबैक कैनवास id (सक्रिय प्रोजेक्ट प्राथमिकता) |
| `logToolCalls` | boolean | `true` | टूल परिणाम सत्र लॉग में जोड़ें |
| `recentLimit` | number | `10` | रखे गए हाल के प्रोजेक्टों की अधिकतम संख्या |
| `trashEnabled` | boolean | `true` | हटाना `<ws>/trash` में जाता है (जब तक स्थायी न हो) |

`src/config.ts` में Schemastery `Config` स्कीमा द्वारा सत्यापित; कोई पैरामीटर हार्डकोड नहीं।

## Development

```sh
pnpm install
pnpm run typecheck        # सर्वर स्रोत
pnpm run typecheck:client # ब्राउज़र स्रोत (tsc)
pnpm test                 # vitest (store/project/asset/search suites)
pnpm run build            # tsdown → lib/
pnpm pack
```

## License

[Apache License 2.0](LICENSE) © 2026 dsh-media-studio contributors.

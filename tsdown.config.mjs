import { defineConfig } from 'tsdown'

/**
 * Two-config build for dsh-media-studio:
 *
 *   1. HOST entry (lib/index.{mjs, d.mts})
 *      - ESM, Node 22
 *      - Bundles tools.ts + llm-bridge.ts + canvas-store.ts + routes.ts +
 *        settings.ts + config.ts + presets/* + media-providers.ts
 *      - DOM-only deps never get bundled into the Node runtime
 *      - `@deepseek-ai/*` packages stay external (peer / runtime deps)
 *
 *   2. CLIENT entry (lib/client.js) — the wrapper the harness requires
 *      - CJS, browser platform
 *      - All non-platform imports get inlined into the factory closure
 *      - All platform imports (`react`, `react-dom/client`, `@xyflow/react`,
 *        etc) stay external — they are resolved from the loader's frozen
 *        module table via the `require` injected into the factory
 *      - banner / intro / footer wrap the whole bundle in
 *        `window.__ModuleLoader__.load({ id, factory })` so the harness
 *        client-modules runtime registers the plugin on load.
 *      - No `.d.ts` for the client wrapper (it is just a factory closure;
 *        the host's dsh.client typings live separately).
 *
 * The dsh web bundle protocol requires the wrapper shape exactly:
 *   window.__ModuleLoader__.load({
 *     id: "<package.name>",
 *     factory: (require) => {
 *       var module = { exports: {} };
 *       var exports = module.exports;
 *       // ... bundled body ...
 *       exports.inject = [...];
 *       exports.apply = ...;
 *       return module.exports;
 *     },
 *   });
 *
 * Without this shape the harness `web boot: 1 entry did not activate`
 * banner fires because client-modules cannot match a factory to the
 * boot-manifest id.
 */

/** Specifiers the harness client-platform preloads into the module table.
 *  Keep them in sync with @deepseek-ai/dsh-client-modules' bootstrap.    */
const PLATFORM_MODULES = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
]

/** Externals resolved from the loader module table. Anything NOT in this list
 *  gets bundled into the wrapper closure so the loader's `require` never sees
 *  it — DSH 0.1.0-rc.7 does not seed UI-vendor libs like @xyflow/react.      */
const CLIENT_EXTERNALS = [...PLATFORM_MODULES]

export default [
  // ── 1. Host entry ─────────────────────────────────────────────────────
  {
    entry: { index: 'src/index.ts' },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'node22',
    fixedExtension: false,
    dts: true,
    clean: true,
    sourcemap: false,
    deps: {
      // Keep framework / runtime deps external so the Node process
      // resolves them through pnpm's graph, not a duplicated copy.
      neverBundle: [
        'react',
        'react-dom',
        '@xyflow/react',
        '@deepseek-ai/schemastery',
        '@deepseek-ai/cordis',
      ],
    },
    esbuild: {
      jsx: 'automatic',
    },
  },

  // ── 2. Client entry: browser factory wrapper ──────────────────────────
  {
    entry: { client: 'src/client.tsx' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    target: 'es2022',
    dts: false,
    clean: false,
    sourcemap: false,
    deps: {
      // Anything in PLATFORM_MODULES stays external so the wrapper's
      // `require` from the loader resolves them; everything else gets
      // inlined into the IIFE-style factory closure.
      neverBundle: [...CLIENT_EXTERNALS],
      alwaysBundle: ['@xyflow/react'],
    },
    define: {
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    },
    esbuild: {
      jsx: 'automatic',
    },
    outputOptions: {
      entryFileNames: 'client.js',
      // The closure-factory handoff every `dsh.client` package's ./client
      // export must use. Mirrors dsh-ads / dsh-context tsdown configs.
      banner: 'window.__ModuleLoader__.load({ id: "dsh-media-studio", factory: (require) => {',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
      footer: 'return module.exports; } });',
    },
  },
]

import { defineConfig } from 'tsdown'

/**
 * Two-entry build:
 *   index.ts    → lib/index.js       (host plugin, runs in the DSH Node process)
 *   client.tsx  → lib/client.js       (browser module, mounted into DSH Web UI)
 *
 * The client entry needs DOM-only deps (react, react-dom, @xyflow/react).
 * We keep them out of the host bundle via the `external` field so the
 * Node-side lib/index.js never imports react.
 */
export default defineConfig({
  entry: {
    index: 'src/index.ts',
    client: 'src/client.tsx',
  },
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  dts: true,
  clean: true,
  sourcemap: false,
  outDir: 'lib',
  // The client build pulls in DOM-only code via src/client.tsx — we let
  // the client bundle include them (browser entry), and EXCLUDE them from
  // the host entry so the Node runtime never tries to resolve them.
  deps: {
    // Per-entry import graphs handle bundling automatically; we just mark
    // DOM-only deps as "never bundle" so the Node entry never tries to
    // resolve them at runtime.
    neverBundle: ['react', 'react-dom', '@xyflow/react'],
  },
  esbuild: {
    // Client entry is for the browser; switch platform per entry is not
    // supported by tsdown, so we keep a single platform: 'node' and let
    // the client code run in a sandbox where window/document are real.
    // The DSH web runtime injects the bundle into an iframe with these
    // globals already wired up.
    jsx: 'automatic',
  },
})

/* media-studio canvas styles — franklin-canvas-inspired card + editor look,
 * themed through DSH CSS vars (with local fallbacks so the canvas reads
 * identically when the vars are absent).
 *
 * This file is the build target export: a stringified CSS block plus the
 * helper that injects it into <head> exactly once per page (the DSH client
 * runtime cannot `require` a .css specifier — see tsdown.config notes).
 *
 * franklin-canvas ships `@xyflow/react/dist/style.css` at its entry; we can't
 * import it here, so the sheet re-implements the xyflow base layout rules it
 * needs (MIT) and then layers the media-studio theme on top.
 */
export const MEDIA_STUDIO_CSS = String.raw`
/* ────────────────────────────────────────────────────────────────
   1. xyflow base layout (subset of @xyflow/react/dist/style.css)
   ──────────────────────────────────────────────────────────────── */
.media-studio-canvas .react-flow {
  position: relative;
  overflow: hidden;
  width: 100%;
  height: 100%;
  direction: ltr;
  font-family: var(--dsw-font-s-14, system-ui, -apple-system, sans-serif);
  font-size: 13px;
}
.media-studio-canvas .react-flow__renderer,
.media-studio-canvas .react-flow__renderer * {
  box-sizing: border-box;
}
.media-studio-canvas .react-flow__renderer {
  position: absolute;
  inset: 0;
  overflow: hidden;
}
.media-studio-canvas .react-flow__viewport {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  transform-origin: 0 0;
}
.media-studio-canvas .react-flow__pane {
  position: absolute;
  inset: 0;
  z-index: 1;
}
.media-studio-canvas .react-flow__pane.draggable,
.media-studio-canvas .react-flow__pane.dragging { cursor: grab; }
.media-studio-canvas .react-flow__pane.dragging { cursor: grabbing; }
.media-studio-canvas .react-flow__selection {
  display: none;
}
.media-studio-canvas .react-flow__edges {
  position: absolute;
  inset: 0;
  z-index: 2;
  pointer-events: none;
  overflow: visible;
}
.media-studio-canvas .react-flow__edge { pointer-events: all; cursor: pointer; }
.media-studio-canvas .react-flow__edge-path { stroke-linecap: round; }
.media-studio-canvas .react-flow__edge-textpointer { cursor: text; }
.media-studio-canvas .react-flow__connection-path {
  stroke: var(--ms-accent, #7c83ff);
  stroke-width: 2;
  stroke-dasharray: 5 4;
  fill: none;
}
.media-studio-canvas .react-flow__nodes {
  position: absolute;
  inset: 0;
  /* Higher than background (0) and xyflow's default for nodes (4) —
   * narrow side-panel panes occasionally re-stack layers in a way
   * that paints the background pattern over the cards. Force the
   * ordering. */
  z-index: 6 !important;
  pointer-events: none;
  transform-origin: 0 0;
}
.media-studio-canvas .react-flow__node {
  position: absolute;
  pointer-events: all;
  -webkit-user-select: none;
  user-select: none;
}
.media-studio-canvas .react-flow__node:focus,
.media-studio-canvas .react-flow__node:focus-visible { outline: none; }
.media-studio-canvas .react-flow__nodesselection,
.media-studio-canvas .react-flow__nodesselection-rect {
  display: none;
}
.media-studio-canvas .react-flow__node-toolbar {
  position: absolute;
  z-index: 30;
  padding: 0;
  border-radius: 10px;
}
.media-studio-canvas .react-flow__handle {
  position: absolute;
  z-index: 5;
  width: 10px;
  height: 10px;
  pointer-events: all;
}
.media-studio-canvas .react-flow__handle-right { right: -5px; top: 50%; transform: translateY(-50%); }
.media-studio-canvas .react-flow__handle-left { left: -5px; top: 50%; transform: translateY(-50%); }
.media-studio-canvas .react-flow__background {
  position: absolute;
  inset: 0;
  z-index: 0;
  pointer-events: none !important;
}
.media-studio-canvas .react-flow__background rect,
.media-studio-canvas .react-flow__background-pattern {
  pointer-events: none !important;
}
.media-studio-canvas .react-flow__minimap {
  /* Side-panel panes are narrow (~450px). xyflow's default MiniMap
   * size is too large and covers the new nodes we just auto-panned
   * to. Pin a fixed size and tuck it into the bottom-right corner. */
  width: 110px;
  height: 70px;
  position: absolute;
  z-index: 10;
  bottom: 12px;
  right: 12px;
  overflow: hidden;
  background: var(--ms-bg2, #171a21);
  border: 1px solid var(--ms-border, rgba(255,255,255,0.09));
  border-radius: 10px;
  box-shadow: var(--ms-shadow-md);
}
.media-studio-canvas .react-flow__minimap svg { display: block; }
.media-studio-canvas .react-flow__attribution { display: none; }

/* ────────────────────────────────────────────────────────────────
   2. Theme tokens
   ──────────────────────────────────────────────────────────────── */
.media-studio-canvas {
  --ms-bg: var(--dsw-alias-bg-base, #0c0e13);
  --ms-bg2: var(--dsw-alias-bg-layer-1, #14171d);
  --ms-card: var(--dsw-alias-bg-layer-2, #1c1f27);
  --ms-card-hi: #232732;
  --ms-fg: var(--dsw-alias-label-primary, #eceef2);
  --ms-fg-dim: var(--dsw-alias-label-secondary, rgba(255,255,255,0.68));
  --ms-fg-faint: var(--dsw-alias-label-tertiary, rgba(255,255,255,0.42));
  --ms-accent: var(--dsw-alias-interactive-bg-hover-accent, #7c83ff);
  --ms-accent-soft: rgba(124, 131, 255, 0.14);
  --ms-border: var(--dsw-alias-border-l2, rgba(255,255,255,0.11));
  --ms-border-strong: var(--dsw-alias-border-l4, rgba(255,255,255,0.24));
  --ms-panel: rgba(26, 29, 38, 0.96);
  --ms-panel-soft: rgba(255,255,255,0.06);
  --ms-error: #ef4444;
  --ms-ok: #4ade80;
  --ms-shadow-sm: 0 1px 2px rgba(0,0,0,0.4), 0 1px 1px rgba(0,0,0,0.3);
  --ms-shadow-md: 0 6px 18px rgba(0,0,0,0.4), 0 2px 5px rgba(0,0,0,0.3);
  --ms-shadow-lg: 0 14px 40px rgba(0,0,0,0.5), 0 5px 12px rgba(0,0,0,0.35);
  --ms-radius: 12px;
  --ms-radius-lg: 18px;
}

.media-studio-canvas {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--ms-bg);
  color: var(--ms-fg);
  font: var(--dsw-font-s-14, 13px/1.45 system-ui, -apple-system, sans-serif);
  contain: layout style;
}

/* ────────────────────────────────────────────────────────────────
   3. Toolbar (add row + live indicator)
   ──────────────────────────────────────────────────────────────── */
.ms-toolbar {
  flex: none;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--ms-border);
  background: var(--ms-bg2);
  z-index: 20;
  user-select: none;
}
.ms-add-row {
  display: flex;
  align-items: center;
  gap: 2px;
  list-style: none;
  padding: 0;
  margin: 0;
  min-width: 0;
  overflow-x: auto;
  scrollbar-width: none;
}
.ms-add-row::-webkit-scrollbar { display: none; }
.ms-add-row li { list-style: none; flex: none; }
.ms-add-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 9px;
  border: 1px solid transparent;
  border-radius: 8px;
  background: transparent;
  color: var(--ms-fg-dim);
  font: 600 12px/1 system-ui, sans-serif;
  cursor: pointer;
  transition:
    background 0.13s ease,
    color 0.13s ease,
    border-color 0.13s ease,
    transform 0.1s ease;
  white-space: nowrap;
}
.ms-add-btn svg { color: var(--ms-accent); flex-shrink: 0; }
.ms-add-btn:hover { background: var(--ms-panel-soft); color: var(--ms-fg); transform: translateY(-1px); }
.ms-add-btn:active { transform: translateY(0); }
.ms-toolbar-spacer { flex: 1; min-width: 8px; }
.ms-live {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font: 600 10.5px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--ms-fg-faint);
  white-space: nowrap;
}
.ms-live-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #6b6b73;
}
.ms-live.is-open .ms-live-dot { background: var(--ms-ok); box-shadow: 0 0 6px rgba(74,222,128,0.8); }
.ms-live.is-reconnecting .ms-live-dot { background: var(--ms-error); }

/* ────────────────────────────────────────────────────────────────
   4. Stage / ReactFlow area
   ──────────────────────────────────────────────────────────────── */
.ms-stage {
  position: relative;
  flex: 1;
  min-height: 0;
  outline: none;
}
.ms-stage .react-flow {
  background: var(--ms-bg);
}
.ms-stage .react-flow__pane { cursor: grab; }
.ms-stage .react-flow__pane.dragging { cursor: grabbing; }
.ms-stage .react-flow__background-pattern { opacity: 1; }

/* selection ring on cards */
.ms-stage .react-flow__node.selected .media-card,
.ms-stage .react-flow__node.selected .canvas-node {
  border-color: var(--ms-accent);
  box-shadow: var(--ms-shadow-lg), 0 0 0 1px var(--ms-accent);
}

/* ────────────────────────────────────────────────────────────────
   5. Card wrappers
   ──────────────────────────────────────────────────────────────── */
.canvas-card-wrap {
  position: relative;
  width: var(--ms-card-w, 240px);
  display: flex;
  flex-direction: column;
  align-items: stretch;
  border-radius: var(--ms-radius-lg);
}
.node-frame-wrap {
  display: flex;
  flex-direction: column;
}

/* editable title row — floats above the card */
.ms-title-row {
  position: absolute;
  bottom: 100%;
  left: 2px;
  right: 2px;
  margin-bottom: 5px;
  display: flex;
  align-items: center;
  gap: 4px;
  color: var(--ms-fg-dim);
  font-size: 11px;
  line-height: 16px;
  min-height: 16px;
}
.ms-title-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
.ms-title-input {
  flex: 1;
  min-width: 0;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--ms-fg-dim);
  font: 500 11px/16px system-ui, sans-serif;
  outline: none;
  text-overflow: ellipsis;
}
.ms-title-input::placeholder { color: var(--ms-fg-faint); }
.ms-title-input:focus { color: var(--ms-fg); }
.ms-title-check { color: var(--ms-ok); flex-shrink: 0; }
.ms-title-error {
  flex-shrink: 0;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: var(--ms-error);
  color: #fff;
  font: 700 10px/14px system-ui, sans-serif;
  text-align: center;
}
.ms-title-idle-dot { flex-shrink: 0; width: 5px; height: 5px; border-radius: 50%; background: #6b6b73; }
.ms-title-spinner {
  flex-shrink: 0;
  width: 11px;
  height: 11px;
  border-radius: 50%;
  border: 2px solid var(--ms-accent-soft);
  border-top-color: var(--ms-accent);
  animation: ms-spin 0.8s linear infinite;
}
@keyframes ms-spin { to { transform: rotate(360deg); } }

/* ────────────────────────────────────────────────────────────────
   6. Floating pill toolbar (hover / selected)
   ──────────────────────────────────────────────────────────────── */
.ms-node-toolbar { display: flex; flex-direction: column; align-items: center; gap: 8px; }
.ms-toolbar-pill-row {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 4px;
  border-radius: 999px;
  background: var(--ms-panel);
  backdrop-filter: blur(14px);
  -webkit-backdrop-filter: blur(14px);
  border: 1px solid var(--ms-border);
  color: var(--ms-fg);
  white-space: nowrap;
  box-shadow: var(--ms-shadow-md);
}
.ms-tb-btn {
  width: 32px;
  height: 32px;
  padding: 0;
  border: 0;
  border-radius: 999px;
  background: transparent;
  color: var(--ms-fg-dim);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: background 0.12s ease, color 0.12s ease;
}
.ms-tb-btn:hover:not(.is-disabled) { background: var(--ms-panel-soft); color: var(--ms-fg); }
.ms-tb-btn.is-disabled { opacity: 0.35; cursor: not-allowed; }

/* ────────────────────────────────────────────────────────────────
   7. Media cards
   ──────────────────────────────────────────────────────────────── */
.media-card {
  position: relative;
  width: 100%;
  aspect-ratio: 1 / 1;
  border-radius: var(--ms-radius-lg);
  background: var(--ms-card);
  border: 1px solid var(--ms-border);
  overflow: hidden;
  box-shadow: var(--ms-shadow-sm);
  transition: box-shadow 0.16s ease, border-color 0.16s ease;
}
.react-flow__node:hover .media-card { border-color: var(--ms-border-strong); box-shadow: var(--ms-shadow-md); }
.media-card.has-result { background: #0b0d10; }
.media-card .media-fill {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  border-radius: var(--ms-radius-lg);
}
.media-img { object-fit: cover; }
.media-video { object-fit: contain; background: #000; }

.media-audio-fill {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 18px;
  background: radial-gradient(120% 120% at 50% 20%, rgba(16,185,129,0.16), transparent 65%),
    var(--ms-card);
}
.media-audio-fill audio { width: 100%; }

.ms-placeholder {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 9px;
  padding: 18px;
  text-align: center;
  color: var(--ms-fg-dim);
  font-size: 12px;
  line-height: 1.45;
  background:
    radial-gradient(130% 120% at 50% 0%, var(--ms-panel-soft), transparent 60%),
    var(--ms-card);
}
.ms-placeholder svg { color: var(--ms-fg-faint); opacity: 0.75; }
.ms-placeholder.ms-error { color: #f0a3a3; }
.ms-placeholder.ms-error svg { color: #f0a3a3; }

.media-overlay {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  background: rgba(8, 9, 12, 0.62);
  backdrop-filter: blur(3px);
  -webkit-backdrop-filter: blur(3px);
}
.ms-spin { animation: ms-spin 0.9s linear infinite; color: var(--ms-accent); }
.media-overlay-hint { font-size: 11.5px; color: rgba(255,255,255,0.85); text-align: center; }
.media-card.status-running { border-color: var(--ms-accent); }

/* ────────────────────────────────────────────────────────────────
   8. Text / note cards
   ──────────────────────────────────────────────────────────────── */
.canvas-node {
  width: 100%;
  background: var(--ms-card);
  border: 1px solid var(--ms-border);
  border-radius: var(--ms-radius-lg);
  overflow: hidden;
  box-shadow: var(--ms-shadow-sm);
  transition: border-color 0.14s ease, box-shadow 0.14s ease;
}
.canvas-node:hover { border-color: var(--ms-border-strong); }
.node-note {
  background: linear-gradient(160deg, rgba(234,179,8,0.10), transparent 45%), var(--ms-card);
  border-color: rgba(234,179,8,0.32);
}
.ms-doc-prompt {
  padding: 8px 12px 0;
  color: var(--ms-fg-faint);
  font-size: 11px;
  line-height: 1.5;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.ms-doc-editor {
  display: block;
  width: 100%;
  box-sizing: border-box;
  min-height: 84px;
  padding: 10px 12px;
  border: 0;
  background: transparent;
  color: var(--ms-fg);
  font: 12px/1.55 system-ui, -apple-system, sans-serif;
  resize: vertical;
  outline: none;
}
.node-note .ms-doc-editor { min-height: 64px; }
.ms-doc-editor::placeholder { color: var(--ms-fg-faint); }
.ms-doc-running {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 2px 12px 10px;
  color: var(--ms-fg-faint);
  font-size: 11px;
}

/* corner delete */
.ms-corner-delete {
  position: absolute;
  top: 8px;
  right: 8px;
  z-index: 6;
  width: 24px;
  height: 24px;
  padding: 0;
  border: 0;
  border-radius: 8px;
  background: rgba(16, 18, 24, 0.78);
  color: #fff;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  opacity: 0;
  transition: opacity 0.14s ease, background-color 0.14s ease, transform 0.1s ease;
  cursor: pointer;
  backdrop-filter: blur(4px);
}
.react-flow__node:hover .ms-corner-delete,
.react-flow__node.selected .ms-corner-delete { opacity: 1; }
.ms-corner-delete:hover { background: rgba(220, 38, 38, 0.92); }
.ms-corner-delete:active { transform: scale(0.92); }

/* "+" side buttons */
.ms-add-side {
  position: absolute;
  top: 50%;
  transform: translateY(-50%);
  z-index: 12;
  width: 26px;
  height: 26px;
  padding: 0;
  border-radius: 50%;
  border: 1.5px solid rgba(255,255,255,0.32);
  background: transparent;
  color: rgba(255,255,255,0.9);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  opacity: 0.6;
  transition: opacity 0.16s ease, transform 0.16s ease, background 0.14s ease, border-color 0.14s ease;
}
.ms-add-left { left: -36px; }
.ms-add-right { right: -36px; }
.ms-add-side:hover {
  background: linear-gradient(135deg, #fde047 0%, #7c83ff 60%, #4ade80 120%);
  color: #0c0e14;
  border-color: transparent;
  opacity: 1;
  transform: translateY(-50%) scale(1.12);
}
.ms-add-side svg { display: block; }
.ms-add-side.is-connected { opacity: 0; }
.canvas-card-wrap:hover .ms-add-side,
.react-flow__node.selected .ms-add-side { opacity: 1; }
.canvas-card-wrap:hover .ms-add-side.is-connected:hover { opacity: 1; }

/* ────────────────────────────────────────────────────────────────
   9. Handles (visible on hover so drag-to-connect stays discoverable)
   ──────────────────────────────────────────────────────────────── */
.ms-handle {
  width: 10px;
  height: 10px;
  background: var(--ms-accent);
  border: 2px solid var(--ms-bg);
  border-radius: 50%;
  opacity: 0.5;
  transition: transform 0.14s ease, opacity 0.14s ease, background 0.14s ease;
}
.react-flow__node:hover .ms-handle,
.react-flow__node.selected .ms-handle { opacity: 1; }
.ms-handle:hover,
.ms-handle.connectingfrom,
.ms-handle.connectingto {
  background: #fff;
  transform: scale(1.5);
  opacity: 1;
}

/* ────────────────────────────────────────────────────────────────
   10. Empty state
   ──────────────────────────────────────────────────────────────── */
.ms-empty {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  pointer-events: none;
  color: var(--ms-fg-faint);
  text-align: center;
  padding: 24px;
}
.ms-empty-title { font: 600 14px/1.5 system-ui, sans-serif; color: var(--ms-fg-dim); }
.ms-empty-sub {
  max-width: 320px;
  font-size: 12px;
  line-height: 1.55;
  color: var(--ms-fg-faint);
}

/* ────────────────────────────────────────────────────────────────
   11. Add-node / connect menus
   ──────────────────────────────────────────────────────────────── */
.ms-menu-backdrop {
  position: fixed;
  inset: 0;
  z-index: 900;
}
.ms-connect-menu {
  position: fixed;
  width: 224px;
  padding: 6px;
  background: var(--ms-panel);
  backdrop-filter: blur(14px);
  -webkit-backdrop-filter: blur(14px);
  border: 1px solid var(--ms-border-strong);
  border-radius: 14px;
  box-shadow: var(--ms-shadow-lg);
  animation: ms-menu-in 0.12s ease-out;
}
@keyframes ms-menu-in {
  from { opacity: 0; transform: translateY(-4px) scale(0.98); }
  to   { opacity: 1; transform: translateY(0) scale(1); }
}
.ms-connect-menu-section {
  padding: 8px 10px 5px;
  font-size: 10.5px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--ms-fg-faint);
}
.ms-connect-menu-item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 8px 10px;
  border: 0;
  border-radius: 9px;
  background: transparent;
  color: var(--ms-fg);
  text-align: left;
  cursor: pointer;
}
.ms-connect-menu-item:hover { background: var(--ms-panel-soft); }
.ms-connect-menu-icon {
  display: inline-flex;
  width: 28px;
  height: 28px;
  align-items: center;
  justify-content: center;
  border-radius: 8px;
  background: var(--ms-bg2);
  flex-shrink: 0;
}
.ms-connect-menu-text { display: flex; flex-direction: column; min-width: 0; }
.ms-connect-menu-label { font-size: 13px; font-weight: 600; }
.ms-connect-menu-desc {
  font-size: 11px;
  color: var(--ms-fg-faint);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ────────────────────────────────────────────────────────────────
   12. View bar (bottom-right pill)
   ──────────────────────────────────────────────────────────────── */
.ms-view-bar {
  position: absolute;
  right: 12px;
  bottom: 12px;
  z-index: 15;
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 5px;
  border-radius: 999px;
  background: var(--ms-panel);
  backdrop-filter: blur(14px);
  -webkit-backdrop-filter: blur(14px);
  border: 1px solid var(--ms-border);
  box-shadow: var(--ms-shadow-md);
  color: var(--ms-fg);
  user-select: none;
}
.ms-view-bar-btn {
  width: 30px;
  height: 30px;
  padding: 0;
  border: 0;
  border-radius: 999px;
  background: transparent;
  color: var(--ms-fg-dim);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: background 0.12s ease, color 0.12s ease;
}
.ms-view-bar-btn:hover { background: var(--ms-panel-soft); color: var(--ms-fg); }
.ms-view-bar-btn.is-active { color: var(--ms-accent); }
.ms-view-bar-divider { width: 1px; height: 16px; background: var(--ms-border); margin: 0 3px; }
.ms-view-bar-pct {
  min-width: 42px;
  height: 30px;
  padding: 0 6px;
  border: 0;
  border-radius: 999px;
  background: transparent;
  color: var(--ms-fg-dim);
  font: 600 11px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
  font-variant-numeric: tabular-nums;
  cursor: pointer;
  transition: background 0.12s ease, color 0.12s ease;
}
.ms-view-bar-pct:hover { background: var(--ms-panel-soft); color: var(--ms-fg); }

/* minimap tucks above the view bar */
.ms-stage .react-flow__minimap { bottom: 58px; width: 150px; height: 96px; }

/* ────────────────────────────────────────────────────────────────
   13. Lightbox
   ──────────────────────────────────────────────────────────────── */
.lightbox-backdrop {
  position: fixed;
  inset: 0;
  z-index: 1200;
  background: rgba(6, 7, 10, 0.88);
  backdrop-filter: blur(6px);
  -webkit-backdrop-filter: blur(6px);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 48px;
  animation: ms-fade-in 0.16s ease-out;
}
@keyframes ms-fade-in { from { opacity: 0; } to { opacity: 1; } }
.lightbox-stage {
  position: relative;
  max-width: min(88vw, 1100px);
  max-height: 84vh;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
}
.lightbox-media { border-radius: 14px; box-shadow: var(--ms-shadow-lg); }
.lightbox-img { max-width: 100%; max-height: 72vh; object-fit: contain; }
.lightbox-video { max-width: 100%; max-height: 74vh; }
.lightbox-audio { width: 480px; max-width: 80vw; }
.lightbox-audio audio { width: 100%; }
.lightbox-footer {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  color: var(--ms-fg-dim);
  font-size: 12px;
}
.lightbox-meta { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.lightbox-meta-prompt {
  color: var(--ms-fg);
  font-size: 12.5px;
  line-height: 1.5;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.lightbox-meta-bits { display: flex; gap: 10px; color: var(--ms-fg-faint); }
.lightbox-close {
  position: absolute;
  top: 16px;
  right: 18px;
  z-index: 2;
  width: 36px;
  height: 36px;
  border: 0;
  border-radius: 50%;
  background: var(--ms-panel);
  color: var(--ms-fg);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  box-shadow: var(--ms-shadow-md);
}
.lightbox-close:hover { color: #fff; background: #2a2e3a; }
.lightbox-nav {
  position: absolute;
  top: 50%;
  transform: translateY(-50%);
  z-index: 2;
  width: 40px;
  height: 60px;
  border: 0;
  border-radius: 12px;
  background: var(--ms-panel);
  color: var(--ms-fg);
  font-size: 24px;
  line-height: 1;
  cursor: pointer;
  box-shadow: var(--ms-shadow-md);
}
.lightbox-nav:hover { color: #fff; background: #2a2e3a; }
.lightbox-prev { left: 18px; }
.lightbox-next { right: 18px; }
.lightbox-download {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 30px;
  padding: 0 12px;
  border: 1px solid var(--ms-border-strong);
  border-radius: 999px;
  background: var(--ms-panel);
  color: var(--ms-fg);
  font-size: 12px;
  cursor: pointer;
}
.lightbox-download:hover { background: var(--ms-panel-soft); color: #fff; }

body.media-studio-previewing { overflow: hidden; }
`

let injected = false

/**
 * Inject MEDIA_STUDIO_CSS into <head> exactly once. Idempotent across
 * remounts; safe to call from multiple React effects. Picked up by the
 * sidebar's panel host because `<style>` lives in <head>, not the panel.
 */
export function injectMediaStudioStyles(): void {
  if (injected) return
  if (typeof document === 'undefined') return
  const tagId = 'dsh-media-studio/canvas.css'
  if (document.querySelector(`style[data-plugin-css="${tagId}"]`) !== null) {
    injected = true
    return
  }
  const tag = document.createElement('style')
  tag.dataset.plugin = 'dsh-media-studio'
  tag.dataset.pluginCss = tagId
  tag.textContent = MEDIA_STUDIO_CSS
  document.head.appendChild(tag)
  injected = true
}

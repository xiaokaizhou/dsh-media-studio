/* media-studio canvas styles — card + editor look,
 * themed through DSH CSS vars (with local fallbacks so the canvas reads
 * identically when the vars are absent).
 *
 * This file is the build target export: a stringified CSS block plus the
 * helper that injects it into <head> exactly once per page (the DSH client
 * runtime cannot `require` a .css specifier — see tsdown.config notes).
 *
 * We re-implement the xyflow base layout rules we need (MIT) and then
 * layer the media-studio theme on top.
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
/* xyflow base layout: every container inside the pane (selection marquee,
 * nodesselection wrapper, edges/nodes/background layers) is absolutely
 * positioned at the pane origin so inline transforms (translate + scale)
 * resolve against left/top instead of the normal document-flow box. Without
 * this, NodesSelection's transform uses the default transform-origin
 * (center center) and the rect detaches from its nodes after mouse-up and
 * during pan/zoom. Redundant for layers that already set position:absolute
 * + inset:0, but matches the official sheet and keeps future xyflow
 * container elements correctly anchored. */
.media-studio-canvas .react-flow__container {
  position: absolute;
  width: 100%;
  height: 100%;
  top: 0;
  left: 0;
}
/* xyflow v12 sets --xy-selection-background-color / --xy-selection-border on
 * .react-flow itself; we layer the media-studio marquee tint on top via
 * .react-flow__selection so the Ctrl/Cmd-drag rectangle reads against our
 * panel background (and matches the accent ring used on selected cards).
 * The dotted default border is too noisy against a dot-grid background.
 *
 * pointer-events: none is critical: the marquee is rendered after
 * pointerdown + before pointerup, and the rect would otherwise swallow
 * the move events (xyflow's pane listens on capture phase, but the rect
 * sits on top of the pane), so without this the marquee would freeze in
 * place the moment it appeared. We rely on xyflow's own pointermove
 * capture handler on the pane — the rect is pure decoration. */
.media-studio-canvas .react-flow__selection {
  background: color-mix(in srgb, var(--ms-accent, #7c83ff) 14%, transparent);
  border: 1px solid color-mix(in srgb, #7c83ff 65%, transparent);
  border-radius: 4px;
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--ms-accent, #7c83ff) 20%, transparent);
  pointer-events: none;
  user-select: none;
  -webkit-user-select: none;
  transform-origin: 0 0;
}
.media-studio-canvas .react-flow__edges {
  position: absolute;
  inset: 0;
  z-index: 2;
  pointer-events: none;
  overflow: visible;
}
/* xyflow v12 renders EACH edge as its own <svg> child of the edges
 * container. Its own stylesheet positions those svgs absolutely so they all
 * overlap at the flow origin (sourceX/sourceY are flow coordinates); without
 * this rule each svg falls back to an inline 300x150 replaced element, so
 * every subsequent edge is shifted/clipped and connection lines no longer
 * line up with their nodes. The re-implemented base sheet must carry it too. */
.media-studio-canvas .react-flow__edges svg {
  position: absolute;
  overflow: visible;
  pointer-events: none;
}
/* xyflow's style.css ships rules for .react-flow__connectionline
 * (position: absolute; width/height 100%; z-index: 1001; overflow: visible)
 * -- but media-studio re-implements the base sheet locally instead of loading
 * xyflow's, so without this rule the live "drag to connect" preview svg
 * collapses to a 300x150 inline-replaced element glued to the top-left of the
 * pane. The path is drawn with viewport-space coordinates relative to the
 * pane origin, so any other layout puts it offscreen (or under a node) and
 * the drag appears to produce no line at all. */
.media-studio-canvas svg.react-flow__connectionline {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  z-index: 1001;
  overflow: visible;
  pointer-events: none;
}
.media-studio-canvas .react-flow__connection { pointer-events: none; }
.media-studio-canvas .react-flow__edge { pointer-events: all; cursor: pointer; }
.media-studio-canvas .react-flow__edge-path {
  stroke-linecap: round;
  /* Chain-highlight dim fade (FlowEdgeView toggles stroke-opacity inline;
   * the transition here makes the state switch smooth). */
  transition: stroke-opacity 0.15s ease;
}
.media-studio-canvas .react-flow__edge-textpointer { cursor: text; }
.media-studio-canvas .react-flow__connection-path {
  stroke: var(--ms-edge-stroke, #7c83ff);
  stroke-width: 2;
  stroke-dasharray: 5 4;
  fill: none;
  /* The drag-preview is overlaid on whatever the pane background is, so we
   * give it a glow rather than risk disappearing into the gradient. The
   * glow follows the same stroke color so it stays cohesive across themes. */
  filter: drop-shadow(0 0 4px color-mix(in srgb, var(--ms-edge-stroke, #7c83ff) 55%, transparent));
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
/* xyflow renders a single bounding-box rectangle (the
 * .react-flow__nodesselection layer + .react-flow__nodesselection-rect)
 * that covers all selected nodes after marquee mouse-up. The wrapper
 * carries the same pan/zoom transform as the viewport so the box stays
 * glued to its nodes. We render it ABOVE the cards (z-index 10 > nodes 6)
 * as a yellow transparent overlay — never painted behind/under the nodes. */
.media-studio-canvas .react-flow__nodesselection {
  z-index: 10;
  transform-origin: 0 0;
  pointer-events: none;
}
.media-studio-canvas .react-flow__nodesselection-rect {
  position: absolute;
  pointer-events: all;
  cursor: grab;
  /* Yellow transparent selection overlay — clearly sits ON TOP of the cards
   * instead of looking like a faint highlight underneath them. */
  background: rgba(250, 204, 21, 0.18);
  border: 1.5px solid rgba(250, 204, 21, 0.75);
  border-radius: var(--ms-radius, 12px);
  box-shadow: 0 0 0 1px rgba(250, 204, 21, 0.25), inset 0 0 24px rgba(250, 204, 21, 0.08);
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
/* Canvas dot-grid fill.
 *
 * xyflow v12 renders dots as a circle inside an SVG pattern. The circle
 * carries the class "react-flow__background-pattern dots" - i.e. it IS the
 * .react-flow__background-pattern element, not a descendant.
 *
 * media-studio does not load xyflow's style.css (we re-implement only the
 * subset we need). Without this rule the dot has no fill at all and renders
 * as solid black against the panel (SVG's default fill is black). Set fill
 * here so the dot follows the DSH theme via the --ms-bg-dot token defined
 * in the dark / light sections above. */
.media-studio-canvas .react-flow__background-pattern.dots {
  fill: var(--ms-bg-dot, rgba(180, 185, 200, 0.55));
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
/* MiniMapWrap always renders the <MiniMap> (so React's hook tree is stable
 * across renders and we never trip invariant #310) but only shows it when the
 * user has toggled the minimap on. Hide the slot without unmounting it. */
.media-studio-canvas .ms-minimap-slot {
  position: absolute;
  inset: 0;
  pointer-events: none;
  z-index: 10;
}
.media-studio-canvas .ms-minimap-slot[data-on="false"] {
  display: none;
}
.media-studio-canvas .ms-minimap-slot[data-on="false"] .react-flow__minimap {
  display: none;
}
.media-studio-canvas .react-flow__minimap svg { display: block; }
/* xyflow's own stylesheet colors minimap nodes/mask through class rules that
 * fall back to its :root palette; the canvas doesn't load that sheet, so
 * without these rules node chips render default black and the mask is inert.
 * Theme them from the ms tokens instead (they flip with the DSH theme). */
.media-studio-canvas .react-flow__minimap-node {
  fill: var(--ms-fg-dim, rgba(255,255,255,0.68));
  stroke: transparent;
}
.media-studio-canvas .react-flow__minimap-mask {
  fill: rgba(8, 10, 14, 0.55);
}
body:not([data-ds-dark-theme]) .media-studio-canvas .react-flow__minimap-mask {
  fill: rgba(250, 251, 252, 0.6);
}
.media-studio-canvas .react-flow__attribution { display: none; }

/* ────────────────────────────────────────────────────────────────
   2. Theme tokens
   ──────────────────────────────────────────────────────────────── */
.media-studio-canvas,
.ms-menu-backdrop {
  /* .ms-menu-backdrop is the portaled <body> host for the add/connect popup
   * (see CreateMenu): it leaves .media-studio-canvas, so the token set it
   * needs is re-declared here on the backdrop itself. */
  --ms-bg: var(--dsw-alias-bg-base, #0c0e13);
  --ms-bg2: var(--dsw-alias-bg-layer-1, #14171d);
  --ms-card: var(--dsw-alias-bg-layer-2, #1c1f27);
  --ms-card-hi: #232732;
  --ms-fg: var(--dsw-alias-label-primary, #eceef2);
  --ms-fg-dim: var(--dsw-alias-label-secondary, rgba(255,255,255,0.68));
  --ms-fg-faint: var(--dsw-alias-label-tertiary, rgba(255,255,255,0.42));
  --ms-accent: var(--dsw-alias-interactive-bg-hover-accent, #7c83ff);
  --ms-accent-soft: rgba(124, 131, 255, 0.14);
  /* Full-opacity stroke for the live "drag to connect" preview line. We
   * deliberately do NOT reuse --ms-accent here: in dark mode that alias
   * resolves to white-with-24%-alpha (#ffffff3d), a *background* hover tint
   * that becomes nearly invisible when used as a stroke. --ms-edge-stroke
   * picks a saturated brand blue (deepseek-400 in dark / deepseek-500 in
   * light) so the dashed preview line stays legible in both themes. */
  --ms-edge-stroke: var(--dsw-alias-brand-primary-new-colorprimary-new-color, #7c83ff);
  --ms-border: var(--dsw-alias-border-l2, rgba(255,255,255,0.11));
  --ms-border-strong: var(--dsw-alias-border-l4, rgba(255,255,255,0.24));
  /* Floating surfaces (menus / pills / view bar) read the host's popover
   * token so they follow the DSH theme instead of staying dark in light
   * mode. */
  --ms-panel: var(--dsw-alias-bg-overlay, rgba(26, 29, 38, 0.96));
  --ms-panel-soft: rgba(255,255,255,0.08);
  --ms-error: #ef4444;
  --ms-ok: #4ade80;
  --ms-shadow-sm: 0 1px 2px rgba(0,0,0,0.4), 0 1px 1px rgba(0,0,0,0.3);
  --ms-shadow-md: 0 6px 18px rgba(0,0,0,0.4), 0 2px 5px rgba(0,0,0,0.3);
  --ms-shadow-lg: 0 14px 40px rgba(0,0,0,0.5), 0 5px 12px rgba(0,0,0,0.35);
  --ms-radius: 12px;
  --ms-radius-lg: 18px;
  /* Canvas dot-grid color — themed so dark mode is clearly visible without
   * being noisy, and light mode reads as a subtle gray mesh instead of
   * disappearing into the panel. */
  --ms-bg-dot: rgba(180, 185, 200, 0.55);
}

/* DSH light color scheme: translucent "panel" tints and shadows that are
 * hard-coded dark above get a light equivalent. Alias tokens (--dsw-alias-*)
 * already flip with the theme, so only the non-tokenized values are reset. */
body:not([data-ds-dark-theme]) .media-studio-canvas,
body:not([data-ds-dark-theme]) .ms-menu-backdrop {
  --ms-card-hi: rgba(15, 17, 22, 0.05);
  --ms-panel-soft: rgba(15, 17, 22, 0.07);
  --ms-shadow-sm: 0 1px 2px rgba(15,17,22,0.10), 0 1px 1px rgba(15,17,22,0.06);
  --ms-shadow-md: 0 6px 18px rgba(15,17,22,0.10), 0 2px 5px rgba(15,17,22,0.06);
  --ms-shadow-lg: 0 14px 40px rgba(15,17,22,0.16), 0 5px 12px rgba(15,17,22,0.10);
  --ms-bg-dot: rgba(60, 65, 80, 0.42);
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
/* Vertical "add a node" capsule dock — left-middle of the canvas (top-row
 * add buttons moved here; version/status badge moved up into the project bar). */
.ms-fab-dock {
  position: absolute;
  left: 14px;
  top: 50%;
  transform: translateY(-50%);
  display: flex;
  flex-direction: column;
  gap: 8px;
  z-index: 18;
  pointer-events: none;
}
.ms-fab-dock-btn {
  pointer-events: auto;
  width: 34px;
  height: 34px;
  border-radius: 50%;
  padding: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--ms-bg2);
  color: var(--ms-accent);
  border: 1px solid var(--ms-border-strong);
  box-shadow: var(--ms-shadow-sm);
  cursor: pointer;
  transition: transform 0.12s ease, background 0.12s ease;
}
.ms-fab-dock-btn:hover { background: var(--ms-card-hi); transform: translateY(-1px) scale(1.06); }
.media-studio-canvas .ms-fab-dock-region {
  margin-top: 6px;
  border-top: 1px solid var(--ms-border, rgba(255, 255, 255, 0.12));
}
.ms-fab-dock-btn:active { transform: scale(0.95); }
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
   4b. Region layer (partition containers, inside the viewport)
   ──────────────────────────────────────────────────────────────── */
/* xyflow's base sheet (which we re-implement locally) sizes the
 * viewport-portal; without it, portal content has no positioning context. */
.media-studio-canvas .react-flow__viewport-portal {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
}
/* The layer is portaled into the transformed viewport, so boxes pan/zoom
 * with the canvas for free. z-index 1: above the dot-grid background (0),
 * below edges (2) / nodes (6). pointer-events: none on the layer; only the
 * title bar and resize handle opt back in (nopan/nodrag keep xyflow's pane
 * from turning those gestures into canvas pans). */
.media-studio-canvas .ms-region-layer {
  position: absolute;
  inset: 0;
  z-index: 1;
  pointer-events: none;
}
.media-studio-canvas .ms-region {
  position: absolute;
  border-radius: 18px;
  border: 1px dashed color-mix(in srgb, var(--ms-accent, #7c83ff) 45%, transparent);
  background:
    linear-gradient(180deg, color-mix(in srgb, var(--ms-accent, #7c83ff) 7%, transparent), transparent 36%),
    color-mix(in srgb, var(--ms-bg2, #14171d) 55%, transparent);
  transition: box-shadow 0.14s ease, border-color 0.14s ease;
}
.media-studio-canvas .ms-region:hover {
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--ms-accent, #7c83ff) 22%, transparent);
}
/* kind-tinted borders — the drama skill ships regions with kinds
 * (flow / script / character / scene / storyboard / output) so each partition
 * reads at a glance. Unknown kinds fall back to the accent above. */
.media-studio-canvas .ms-region[data-kind="flow"] { border-color: color-mix(in srgb, #22d3ee 50%, transparent); }
.media-studio-canvas .ms-region[data-kind="script"] { border-color: color-mix(in srgb, #f59e0b 50%, transparent); }
.media-studio-canvas .ms-region[data-kind="character"] { border-color: color-mix(in srgb, #f472b6 50%, transparent); }
.media-studio-canvas .ms-region[data-kind="scene"] { border-color: color-mix(in srgb, #4ade80 50%, transparent); }
.media-studio-canvas .ms-region[data-kind="storyboard"] { border-color: color-mix(in srgb, #a78bfa 50%, transparent); }
.media-studio-canvas .ms-region[data-kind="output"] { border-color: color-mix(in srgb, #fb923c 50%, transparent); }
.media-studio-canvas .ms-region-title {
  position: absolute;
  top: 10px;
  left: 12px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: calc(100% - 24px);
  padding: 3px 5px 3px 11px;
  border-radius: 999px;
  background: var(--ms-panel, rgba(26, 29, 38, 0.96));
  border: 1px solid var(--ms-border, rgba(255, 255, 255, 0.11));
  box-shadow: var(--ms-shadow-sm);
  color: var(--ms-fg);
  font: 600 12px/1 system-ui, -apple-system, sans-serif;
  pointer-events: auto;
  user-select: none;
}
.media-studio-canvas .ms-region-label {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.media-studio-canvas .ms-region-kind {
  flex: none;
  padding: 1px 7px;
  border-radius: 999px;
  background: var(--ms-accent-soft, rgba(124, 131, 255, 0.14));
  color: var(--ms-fg-dim);
  font: 600 9.5px/1.5 system-ui, -apple-system, sans-serif;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.media-studio-canvas .ms-region-title-spacer { flex: none; width: 1px; }
.media-studio-canvas .ms-region-btn {
  flex: none;
  width: 20px;
  height: 20px;
  padding: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: 999px;
  background: transparent;
  color: var(--ms-fg-faint);
  cursor: pointer;
  transition: background 0.12s ease, color 0.12s ease, transform 0.1s ease;
}
.media-studio-canvas .ms-region-btn:hover { background: var(--ms-panel-soft); color: var(--ms-fg); transform: scale(1.1); }
.media-studio-canvas .ms-region-btn.ms-region-btn-danger:hover { background: rgba(220, 38, 38, 0.22); color: #fca5a5; }
/* Drag handle — four-dot grip on the left side of the title bar. */
.media-studio-canvas .ms-region-drag-handle {
  flex: none;
  width: 18px;
  height: 18px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: grab;
  border-radius: 4px;
  color: var(--ms-fg-faint);
  transition: background 0.12s ease, color 0.12s ease;
}
.media-studio-canvas .ms-region-drag-handle:hover { background: var(--ms-panel-soft); color: var(--ms-fg); }
.media-studio-canvas .ms-region-drag-handle:active { cursor: grabbing; }
/* Clickable label — shows a subtle hint that it can be renamed. */
.media-studio-canvas .ms-region-label-clickable {
  cursor: text;
  border-bottom: 1px dashed transparent;
  transition: border-color 0.12s ease;
}
.media-studio-canvas .ms-region-label-clickable:hover { border-bottom-color: var(--ms-fg-faint); }
/* Inline rename input */
.media-studio-canvas .ms-region-rename-input {
  flex: 1;
  min-width: 0;
  max-width: 160px;
  padding: 1px 6px;
  border: 1px solid var(--ms-accent);
  border-radius: 4px;
  background: var(--ms-bg);
  color: var(--ms-fg);
  font: 600 12px/1 system-ui, sans-serif;
  outline: none;
}
/* Constrained region visual hint — subtle solid border. */
.media-studio-canvas .ms-region[data-constrained="true"] {
  border-style: solid;
  border-color: color-mix(in srgb, var(--ms-accent, #7c83ff) 55%, transparent);
}
.media-studio-canvas .ms-region[data-constrained="true"]:hover {
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--ms-accent, #7c83ff) 30%, transparent), 0 0 0 1px color-mix(in srgb, var(--ms-accent, #7c83ff) 20%, transparent);
}
/* Transparent body overlay — absorbs pointer events on empty region space
   so they don't fall through to the ReactFlow pane and trigger canvas pan. */
.media-studio-canvas .ms-region-body {
  position: absolute;
  inset: 0;
  top: 64px;       /* below the title bar */
  bottom: 0;
  right: 0;
  pointer-events: auto;
  z-index: 0;
}
/* Resize grip — bottom-right corner, visible on hover. */
.media-studio-canvas .ms-region-resize {
  position: absolute;
  right: 0;
  bottom: 0;
  width: 22px;
  height: 22px;
  cursor: nwse-resize;
  pointer-events: auto;
  opacity: 0;
  border-radius: 0 0 18px 0;
  background:
    linear-gradient(
      135deg,
      transparent 44%,
      color-mix(in srgb, var(--ms-accent, #7c83ff) 35%, transparent) 44%,
      var(--ms-accent, #7c83ff) 100%
    );
  transition: opacity 0.14s ease;
}
.media-studio-canvas .ms-region:hover .ms-region-resize,
.media-studio-canvas .ms-region-resize:hover { opacity: 1; }

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
  /* Chain-highlight dim fade — opacity-only so the transition runs on the
   * compositor (no layout, no repainted children). */
  transition: opacity 0.15s ease;
}
/* Upstream/downstream chain highlight (see dim-store.ts): while a node is
 * selected, cards outside the related set render dimmed. Hovering a dimmed
 * card restores it to full opacity so unrelated nodes stay reachable. */
.canvas-card-wrap.ms-dimmed { opacity: 0.28; }
.canvas-card-wrap.ms-dimmed:hover { opacity: 1; }
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
  margin-bottom: 8px;
  display: flex;
  align-items: center;
  gap: 4px;
  color: var(--ms-fg);
  font-size: 11px;
  line-height: 16px;
  min-height: 16px;
  text-shadow: 0 1px 3px rgba(0, 0, 0, 0.6);
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
.media-card.ms-media-music {
  aspect-ratio: 16 / 9;
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
.media-video-slot {
  background: #000;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  position: relative;
  overflow: hidden;
}
.media-video-slot .media-lazy-hint { color: rgba(255,255,255,0.6); font-size: 15px; }
.media-lazy-hint { pointer-events: none; user-select: none; }
/* Poster <img> — the ENTIRE idle card before first play (no <video> element
   exists yet, so there is nothing to overlap and no browser-specific poster
   quirk). Clicking anywhere mounts the video and plays it. */
.media-video-poster {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: contain;
  background: #000;
  border-radius: var(--ms-radius-lg);
  z-index: 2;
  pointer-events: none;
  user-select: none;
}
/* Centered play button — always visible while not playing, regardless of
   hover state, so Chrome matches Safari's default (no native controls). */
.media-video-play-btn {
  position: absolute;
  z-index: 3;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 48px;
  height: 48px;
  cursor: pointer;
  pointer-events: none;
  user-select: none;
  transition: transform 0.15s ease;
}
.media-video-slot:hover .media-video-play-btn {
  transform: scale(1.08);
}


.media-audio-fill {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: stretch;
  justify-content: center;
  padding: 14px;
  background: radial-gradient(120% 120% at 50% 20%, rgba(16,185,129,0.16), transparent 65%),
    var(--ms-card);
}
.media-audio-fill audio { display: none; }

.ms-audio-editor {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px;
}
.ms-audio-wave {
  width: 100%;
  flex: 1;
  min-height: 56px;
  border-radius: 10px;
  background: rgba(255,255,255,0.04);
  border: 1px solid var(--ms-border);
  cursor: pointer;
  /* Pointer drag-to-seek owns the gesture — don't let touch pan/zoom the
     canvas while the user drags the playhead. */
  touch-action: none;
}
.ms-audio-wave:focus-visible {
  outline: 2px solid var(--ms-accent, #7c83ff);
  outline-offset: 2px;
}
.ms-audio-controls {
  display: flex;
  align-items: center;
  gap: 10px;
}
.ms-audio-play {
  width: 32px;
  height: 32px;
  border-radius: 999px;
  border: 1px solid var(--ms-border-strong);
  background: var(--ms-panel-soft);
  color: var(--ms-fg);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
}
.ms-audio-play:hover { background: var(--ms-accent); color:#0b0d12; }
.ms-audio-scrub {
  flex: 1;
  min-width: 0;
  accent-color: var(--ms-accent);
  /* Keep range-thumb dragging in the thumb's hands, not the canvas pan. */
  touch-action: none;
}
.ms-audio-time {
  font: 600 11px/1 ui-monospace, Menlo, monospace;
  color: var(--ms-fg-faint);
  min-width: 32px;
  text-align: right;
}
.ms-audio-err {
  font-size: 10.5px;
  color: var(--ms-fg-faint);
  text-align: center;
}

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
.ms-placeholder-hint {
  font-size: 10.5px;
  color: var(--ms-fg-faint);
  line-height: 1.4;
  max-width: 90%;
  opacity: 0.85;
}

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
  /* Default layout is content-sized (prompt + textarea at its natural rows
     height). Once the user pins a height via the resize grip (.is-fixed,
     inline height) the card becomes a flex column and the editor fills the
     remaining space, scrolling internally instead of stretching the card. */
}
.canvas-node.is-fixed {
  display: flex;
  flex-direction: column;
  min-height: 0;
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
  height: auto;
  min-height: 84px;
  box-sizing: border-box;
  padding: 10px 12px;
  border: 0;
  background: transparent;
  color: var(--ms-fg);
  font: 12px/1.55 system-ui, -apple-system, sans-serif;
  resize: none;
  outline: none;
}
.node-note .ms-doc-editor { min-height: 64px; }
.canvas-node.is-fixed .ms-doc-editor {
  flex: 1 1 auto;
  min-height: 0;
  /* Fill the container height instead of auto-expanding. The container has
     overflow:hidden, so content that exceeds the card height scrolls
     internally rather than stretching the node infinitely. */
  height: 100%;
  overflow-y: auto;
}
.ms-doc-editor::placeholder { color: var(--ms-fg-faint); }
/* Empty-content hint: paints the textarea border red and slots a small
   warning chip below it when the canonical content field is empty.
   The agent's contract says text/note nodes must carry non-empty
   data.text / data.content; this UI makes a missed write immediately
   visible instead of leaving a blank card behind. */
.ms-doc-editor.is-empty {
  background:
    repeating-linear-gradient(
      45deg,
      rgba(239,68,68,0.04) 0px,
      rgba(239,68,68,0.04) 8px,
      transparent 8px,
      transparent 16px
    );
}
.ms-doc-editor.is-empty:focus {
  background: transparent;
}
.ms-doc-empty-warn {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0 12px 10px;
  padding: 5px 8px;
  border-radius: 4px;
  background: rgba(239,68,68,0.10);
  border: 1px solid rgba(239,68,68,0.35);
  color: rgba(252,165,165,0.95);
  font-size: 10.5px;
  line-height: 1.4;
  pointer-events: none;
}
.ms-doc-empty-icon {
  font-size: 11px;
  flex: 0 0 auto;
}
.ms-doc-empty-text {
  flex: 1 1 auto;
  min-width: 0;
}
.ms-doc-running {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 2px 12px 10px;
  color: var(--ms-fg-faint);
  font-size: 11px;
}

/* ────────────────────────────────────────────────────────────────
    9. Vertical resize grip (Text/Note cards, bottom-right corner)
    ──────────────────────────────────────────────────────────────── */
.ms-resize-handle-wrap {
  position: absolute;
  right: 0;
  bottom: 0;
  width: 20px;
  height: 20px;
  cursor: ns-resize;
  touch-action: none; /* keep the drag from panning/zooming the canvas on touch */
  z-index: 8;
  /* Corner triangle — reads as a grip, glows when the drag is active */
  background: linear-gradient(
    135deg,
    transparent 42%,
    var(--ms-accent-soft) 42%,
    var(--ms-accent) 100%
  );
  border-radius: 0 0 var(--ms-radius-lg) 0;
  opacity: 0;
  transition: opacity 0.14s ease, background 0.14s ease;
}
.canvas-card-wrap:hover .ms-resize-handle-wrap,
.react-flow__node.selected .ms-resize-handle-wrap { opacity: 1; }
.canvas-card-wrap .ms-resize-handle-wrap:hover,
.canvas-card-wrap:active .ms-resize-handle-wrap { opacity: 1; background: var(--ms-accent); }
/* Keep existing NodeResizer classes for media nodes that may use them later */
.ms-resize-handle {
  width: 10px;
  height: 10px;
  background: var(--ms-accent);
  border: 2px solid var(--ms-bg);
  border-radius: 50%;
  opacity: 0;
  transition: opacity 0.14s ease, background 0.14s ease;
}
.react-flow__node:hover .ms-resize-handle,
.react-flow__node.selected .ms-resize-handle { opacity: 0.7; }
.ms-resize-handle:hover { opacity: 1; background: #fff; }
.ms-resize-line {
  stroke: var(--ms-accent);
  stroke-width: 1.5;
  stroke-dasharray: 4 3;
  opacity: 0;
  transition: opacity 0.14s ease;
  pointer-events: none;
}
.react-flow__node:hover .ms-resize-line,
.react-flow__node.selected .ms-resize-line { opacity: 0.5; }

/* ────────────────────────────────────────────────────────────────
    10. Connection handles (visible on hover so drag-to-connect stays discoverable)
    ──────────────────────────────────────────────────────────────── */
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

/* Refresh button — positioned at the bottom-center, half-poking below the
 * card so it reads as a floating pill. 26px tall + 10px gap = bottom:-36px,
 * matching the side "+" buttons' 36px offset. */
.ms-refresh-btn {
  position: absolute;
  bottom: -36px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 12;
  width: 26px;
  height: 26px;
  padding: 0;
  border-radius: 50%;
  border: 1.5px solid rgba(255,255,255,0.32);
  background: transparent;
  color: var(--ms-accent, #7c83ff);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.16s ease, transform 0.16s ease, background 0.14s ease, border-color 0.14s ease;
}
.canvas-card-wrap:hover .ms-refresh-btn,
.react-flow__node.selected .ms-refresh-btn {
  opacity: 1;
}
.ms-refresh-btn:hover {
  background: var(--ms-accent, #7c83ff);
  color: #0c0e14;
  border-color: transparent;
  transform: translateX(-50%) scale(1.12);
}
.ms-refresh-btn:disabled {
  opacity: 0.7;
  cursor: not-allowed;
}

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
/* Floating menus (the canvas right-click "add a node" popup, the top-bar
 * "项目" dropdown) reuse this as their body-portal host. The backdrop itself
 * MUST NOT swallow pointer events: when it did (z-index 900 over the entire
 * viewport, invisible), clicks meant for the top bar's "项目" button, the
 * "download canvas" icon, or anything else outside the canvas were eaten by
 * the backdrop's onClose handler instead of reaching the top bar — leaving
 * users thinking the canvas was "blocking UI" (issue: 画布当前有事件阻塞UI).
 *
 * Floating-menu backdrops are now pointer-event transparent and only their
 * child menu/dialog receives pointer events; an outside-click listener on
 * the menu component closes it. Modal dialogs (SaveToLibraryDialog, project
 * new/rename/delete) opt back into a clickable backdrop with the
 * is-modal modifier — those still need to dismiss on outside click and
 * are intentionally modal. */
.ms-menu-backdrop {
  position: fixed;
  inset: 0;
  z-index: 900;
  pointer-events: none;
}
.ms-menu-backdrop > * {
  pointer-events: auto;
}
.ms-menu-backdrop.is-modal {
  pointer-events: auto;
  background: rgba(6, 7, 10, 0.32);
  animation: ms-fade-in 0.12s ease-out;
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

/* ────────────────────────────────────────────────────────────────
    14. Clear-canvas confirmation dialog
    ──────────────────────────────────────────────────────────────── */
.ms-clear-confirm-backdrop {
  position: fixed;
  inset: 0;
  z-index: 1100;
  background: rgba(6, 7, 10, 0.6);
  backdrop-filter: blur(4px);
  -webkit-backdrop-filter: blur(4px);
  display: flex;
  align-items: center;
  justify-content: center;
  animation: ms-fade-in 0.12s ease-out;
}
.ms-clear-confirm-dialog {
  width: 340px;
  padding: 20px 22px 18px;
  background: var(--ms-panel);
  border: 1px solid var(--ms-border-strong);
  border-radius: 16px;
  box-shadow: var(--ms-shadow-lg);
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.ms-clear-confirm-title {
  font: 600 14px/1.3 system-ui, sans-serif;
  color: var(--ms-fg);
}
.ms-clear-confirm-body {
  font-size: 13px;
  line-height: 1.5;
  color: var(--ms-fg-dim);
}
.ms-clear-confirm-actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
  margin-top: 2px;
}
.ms-btn-cancel,
.ms-btn-danger {
  height: 32px;
  padding: 0 14px;
  border-radius: 8px;
  font: 600 12.5px/1 system-ui, sans-serif;
  cursor: pointer;
  transition: background 0.12s ease, color 0.12s ease;
}
.ms-btn-cancel {
  background: transparent;
  border: 1px solid var(--ms-border);
  color: var(--ms-fg-dim);
}
.ms-btn-cancel:hover { background: var(--ms-panel-soft); color: var(--ms-fg); }
.ms-btn-danger {
  background: rgba(220, 38, 38, 0.15);
  border: 1px solid rgba(220, 38, 38, 0.4);
  color: #fca5a5;
}
.ms-btn-danger:hover { background: rgba(220, 38, 38, 0.28); color: #fecaca; }
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

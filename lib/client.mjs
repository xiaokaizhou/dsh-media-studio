import { createElement, memo, useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { Background, Controls, Handle, MiniMap, Position, ReactFlow, addEdge, useEdgesState, useNodesState } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
//#region src/client/nodes.tsx
const KIND_META = {
	text: {
		icon: "T",
		tint: "#7c83ff",
		sublabel: "Text"
	},
	image: {
		icon: "I",
		tint: "#f59e0b",
		sublabel: "Image"
	},
	video: {
		icon: "V",
		tint: "#ef4444",
		sublabel: "Video"
	},
	music: {
		icon: "M",
		tint: "#10b981",
		sublabel: "Voice"
	},
	note: {
		icon: "N",
		tint: "#94a3b8",
		sublabel: "Note"
	}
};
function MediaNodeImpl({ data, selected }) {
	const d = data;
	const meta = KIND_META[d.kind] ?? KIND_META.note;
	const status = d.status ?? "idle";
	return /* @__PURE__ */ jsxs("div", {
		className: `media-studio-node media-studio-node-${d.kind} media-studio-status-${status}`,
		style: {
			borderColor: selected ? meta.tint : "rgba(255,255,255,0.12)",
			boxShadow: selected ? `0 0 0 2px ${meta.tint}40` : void 0
		},
		children: [
			/* @__PURE__ */ jsx(Handle, {
				type: "target",
				position: Position.Left,
				className: "media-studio-handle"
			}),
			/* @__PURE__ */ jsx(Handle, {
				type: "source",
				position: Position.Right,
				className: "media-studio-handle"
			}),
			/* @__PURE__ */ jsxs("div", {
				className: "media-studio-node-head",
				style: { background: meta.tint },
				children: [
					/* @__PURE__ */ jsx("span", {
						className: "media-studio-node-icon",
						children: meta.icon
					}),
					/* @__PURE__ */ jsx("span", {
						className: "media-studio-node-sublabel",
						children: meta.sublabel
					}),
					status === "running" && /* @__PURE__ */ jsx("span", { className: "media-studio-node-spinner" }),
					status === "done" && /* @__PURE__ */ jsx("span", {
						className: "media-studio-node-done",
						children: "✓"
					}),
					status === "error" && /* @__PURE__ */ jsx("span", {
						className: "media-studio-node-error",
						children: "✗"
					})
				]
			}),
			/* @__PURE__ */ jsxs("div", {
				className: "media-studio-node-body",
				children: [
					/* @__PURE__ */ jsx("div", {
						className: "media-studio-node-label",
						children: d.label
					}),
					d.prompt && /* @__PURE__ */ jsx("div", {
						className: "media-studio-node-prompt",
						children: truncate(d.prompt, 120)
					}),
					d.model && /* @__PURE__ */ jsx("div", {
						className: "media-studio-node-model",
						children: d.model
					}),
					d.resultUrl && d.kind === "image" && /* @__PURE__ */ jsx("img", {
						className: "media-studio-preview",
						src: d.resultUrl,
						alt: ""
					}),
					d.resultUrl && d.kind === "video" && /* @__PURE__ */ jsx("video", {
						className: "media-studio-preview",
						src: d.resultUrl,
						controls: true,
						preload: "metadata"
					}),
					d.resultUrl && d.kind === "music" && /* @__PURE__ */ jsx("audio", {
						className: "media-studio-preview",
						src: d.resultUrl,
						controls: true
					})
				]
			})
		]
	});
}
function truncate(s, n) {
	return s.length <= n ? s : s.slice(0, n - 1) + "…";
}
const MediaNode = memo(MediaNodeImpl);
//#endregion
//#region src/client/canvas.tsx
/**
* Subscribe to the host's canvas SSE stream and accumulate the latest
* snapshot. Returns a state object that's safe to read synchronously from
* the render path (no ref juggling).
*/
function useCanvasState(canvasId) {
	const [snap, setSnap] = useState(null);
	useEffect(() => {
		const es = new EventSource(`/api/media-studio/canvas/sse?canvasId=${encodeURIComponent(canvasId)}`);
		es.addEventListener("canvas-patch", (e) => {
			try {
				const data = JSON.parse(e.data);
				if (data?.type === "canvas-patch" && data.graph) setSnap({
					graph: data.graph,
					version: data.version ?? 0
				});
			} catch {}
		});
		es.addEventListener("error", () => {
			console.warn("[media-studio] canvas SSE error, will retry");
		});
		return () => es.close();
	}, [canvasId]);
	return snap;
}
function Canvas({ host }) {
	const canvasId = useMemo(() => readCanvasIdFromHost(host) ?? "main", [host]);
	const snap = useCanvasState(canvasId);
	const nodeTypes = useMemo(() => ({
		text: MediaNode,
		image: MediaNode,
		video: MediaNode,
		music: MediaNode,
		note: MediaNode
	}), []);
	const initialNodes = useMemo(() => snap?.graph.nodes.map((n) => ({
		id: n.id,
		type: n.type,
		position: n.position ?? {
			x: 0,
			y: 0
		},
		data: {
			kind: n.type,
			...n.data
		}
	})) ?? [], [snap]);
	const initialEdges = useMemo(() => snap?.graph.edges.map((e) => ({
		id: e.id,
		source: e.source,
		target: e.target
	})) ?? [], [snap]);
	const [nodes, setNodes, onNodesChangeBase] = useNodesState(initialNodes);
	const [edges, setEdges, onEdgesChangeBase] = useEdgesState(initialEdges);
	useEffect(() => {
		if (!snap) return;
		setNodes(initialNodes);
		setEdges(initialEdges);
	}, [snap?.version]);
	const onNodesChange = useCallback((changes) => onNodesChangeBase(changes), [onNodesChangeBase]);
	const onEdgesChange = useCallback((changes) => onEdgesChangeBase(changes), [onEdgesChangeBase]);
	const onConnect = useCallback((conn) => {
		if (!conn.source || !conn.target) return;
		setEdges((eds) => addEdge({
			...conn,
			id: `e-${Date.now()}`
		}, eds));
		postOps(canvasId, [{
			op: "connect",
			from: conn.source,
			to: conn.target
		}]);
	}, [canvasId, setEdges]);
	const onAdd = useCallback((kind) => {
		const id = `n-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
		const position = pickFreePosition(nodes);
		postOps(canvasId, [{
			op: "addNode",
			type: kind,
			label: `New ${kind}`,
			data: {
				kind,
				status: "idle"
			},
			position
		}]);
		setNodes((ns) => [...ns, {
			id,
			type: kind,
			position,
			data: {
				kind,
				label: `New ${kind}`,
				status: "idle"
			}
		}]);
	}, [
		canvasId,
		nodes,
		setNodes
	]);
	return /* @__PURE__ */ jsxs("div", {
		className: "media-studio-canvas",
		style: {
			width: "100%",
			height: "100%"
		},
		children: [/* @__PURE__ */ jsx(Toolbar, {
			onAdd,
			version: snap?.version ?? 0
		}), /* @__PURE__ */ jsxs(ReactFlow, {
			nodes,
			edges,
			onNodesChange,
			onEdgesChange,
			onConnect,
			nodeTypes,
			fitView: true,
			proOptions: { hideAttribution: true },
			style: { background: "transparent" },
			children: [
				/* @__PURE__ */ jsx(Background, {
					gap: 24,
					size: 1
				}),
				/* @__PURE__ */ jsx(Controls, {}),
				/* @__PURE__ */ jsx(MiniMap, {
					pannable: true,
					zoomable: true
				})
			]
		})]
	});
}
function Toolbar({ onAdd, version }) {
	return /* @__PURE__ */ jsxs("div", {
		className: "media-studio-toolbar",
		children: [[
			["text", "Text"],
			["image", "Image"],
			["video", "Video"],
			["music", "Voice"],
			["note", "Note"]
		].map(([k, label]) => /* @__PURE__ */ jsx("button", {
			type: "button",
			onClick: () => onAdd(k),
			children: label
		}, k)), /* @__PURE__ */ jsxs("span", {
			className: "media-studio-version",
			children: ["v", version]
		})]
	});
}
function readCanvasIdFromHost(host) {
	return host.getAttribute("data-canvas-id") || null;
}
/** Place a new node below the lowest existing node so it doesn't overlap. */
function pickFreePosition(nodes) {
	if (nodes.length === 0) return {
		x: 60,
		y: 60
	};
	let maxY = 0;
	for (const n of nodes) {
		const y = (n.position?.y ?? 0) + 200;
		if (y > maxY) maxY = y;
	}
	return {
		x: 60,
		y: maxY + 40
	};
}
/** Fire-and-forget POST of canvas ops to the host's REST endpoint. The
*  host's apply() runs synchronously; the SSE broadcast will reconcile
*  the local state once the call returns. */
async function postOps(canvasId, ops) {
	try {
		await fetch("/api/media-studio/canvas/patch", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				canvasId,
				ops
			})
		});
	} catch (e) {
		console.error("[media-studio] canvas patch failed:", e.message);
	}
}
//#endregion
//#region src/client/settings-panel.tsx
const EMPTY = {
	textModel: "",
	image: {
		provider: "custom-agnes",
		baseURL: "https://apihub.agnes-ai.com/v1",
		apiKey: "",
		defaultModel: "agnes-image-2.1-flash"
	},
	video: {
		provider: "custom-agnes",
		baseURL: "https://apihub.agnes-ai.com/v1",
		apiKey: "",
		defaultModel: "agnes-video-2.5-flash"
	},
	music: {
		provider: "custom-minimax",
		baseURL: "https://api.minimaxi.com",
		apiKey: "",
		defaultModel: "speech-02-hd",
		voice: "male-qn-jingying"
	}
};
function SettingsPanel({ host }) {
	const [value, setValue] = useState(EMPTY);
	const [revision, setRevision] = useState(0);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState(null);
	useEffect(() => {
		fetch("/api/settings/describe?ns=media-studio&redactSecrets=false", { credentials: "include" }).then((r) => r.ok ? r.json() : null).then((data) => {
			const v = data?.value;
			if (v) setValue({
				...EMPTY,
				...v
			});
			setRevision(data?.revision ?? 0);
		}).catch((e) => setError(`load failed: ${e.message}`));
	}, []);
	const save = useCallback(async () => {
		setSaving(true);
		setError(null);
		try {
			const r = await fetch("/api/settings/update", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				credentials: "include",
				body: JSON.stringify({
					ns: "media-studio",
					value,
					expectedRevision: revision
				})
			});
			if (!r.ok) throw new Error(`HTTP ${r.status}`);
			const data = await r.json();
			setRevision(data?.revision ?? revision);
		} catch (e) {
			setError(`save failed: ${e.message}`);
		} finally {
			setSaving(false);
		}
	}, [value, revision]);
	return /* @__PURE__ */ jsxs("div", {
		className: "media-studio-settings",
		"data-canvas-host": host,
		children: [
			/* @__PURE__ */ jsx("h3", { children: "Media Studio" }),
			/* @__PURE__ */ jsx("p", {
				className: "media-studio-hint",
				children: "Configure your LLM (text) and media providers (image / video / voice). Keys stay on this machine; only the plugin reads them."
			}),
			/* @__PURE__ */ jsxs("fieldset", { children: [/* @__PURE__ */ jsx("legend", { children: "Text (uses DSH-configured LLM)" }), /* @__PURE__ */ jsxs("label", { children: [/* @__PURE__ */ jsxs("span", { children: [
				"Default model (e.g. ",
				/* @__PURE__ */ jsx("code", { children: "deepseek/deepseek-chat" }),
				")"
			] }), /* @__PURE__ */ jsx("input", {
				type: "text",
				value: value.textModel,
				placeholder: "deepseek/deepseek-chat",
				onChange: (e) => setValue({
					...value,
					textModel: e.target.value
				})
			})] })] }),
			/* @__PURE__ */ jsxs("fieldset", { children: [/* @__PURE__ */ jsx("legend", { children: "Image" }), /* @__PURE__ */ jsx(ProviderFields, {
				value: value.image,
				onChange: (image) => setValue({
					...value,
					image
				}),
				defaultModelPlaceholder: "agnes-image-2.1-flash"
			})] }),
			/* @__PURE__ */ jsxs("fieldset", { children: [/* @__PURE__ */ jsx("legend", { children: "Video" }), /* @__PURE__ */ jsx(ProviderFields, {
				value: value.video,
				onChange: (video) => setValue({
					...value,
					video
				}),
				defaultModelPlaceholder: "agnes-video-2.5-flash"
			})] }),
			/* @__PURE__ */ jsxs("fieldset", { children: [
				/* @__PURE__ */ jsx("legend", { children: "Voice (TTS)" }),
				/* @__PURE__ */ jsx(ProviderFields, {
					value: value.music,
					onChange: (music) => setValue({
						...value,
						music
					}),
					defaultModelPlaceholder: "speech-02-hd"
				}),
				/* @__PURE__ */ jsxs("label", { children: [/* @__PURE__ */ jsx("span", { children: "Default voice" }), /* @__PURE__ */ jsx("input", {
					type: "text",
					value: value.music.voice,
					placeholder: "male-qn-jingying",
					onChange: (e) => setValue({
						...value,
						music: {
							...value.music,
							voice: e.target.value
						}
					})
				})] })
			] }),
			error && /* @__PURE__ */ jsx("p", {
				className: "media-studio-error",
				role: "alert",
				children: error
			}),
			/* @__PURE__ */ jsx("div", {
				className: "media-studio-actions",
				children: /* @__PURE__ */ jsx("button", {
					type: "button",
					onClick: save,
					disabled: saving,
					children: saving ? "Saving…" : "Save"
				})
			})
		]
	});
}
function ProviderFields({ value, onChange, defaultModelPlaceholder }) {
	return /* @__PURE__ */ jsxs(Fragment, { children: [
		/* @__PURE__ */ jsxs("label", { children: [/* @__PURE__ */ jsxs("span", { children: [
			"Provider id (e.g. ",
			/* @__PURE__ */ jsx("code", { children: "custom-agnes" }),
			")"
		] }), /* @__PURE__ */ jsx("input", {
			type: "text",
			value: value.provider,
			onChange: (e) => onChange({
				...value,
				provider: e.target.value
			})
		})] }),
		/* @__PURE__ */ jsxs("label", { children: [/* @__PURE__ */ jsx("span", { children: "Base URL" }), /* @__PURE__ */ jsx("input", {
			type: "text",
			value: value.baseURL,
			onChange: (e) => onChange({
				...value,
				baseURL: e.target.value
			}),
			placeholder: "https://…"
		})] }),
		/* @__PURE__ */ jsxs("label", { children: [/* @__PURE__ */ jsx("span", { children: "API key" }), /* @__PURE__ */ jsx("input", {
			type: "password",
			value: value.apiKey,
			onChange: (e) => onChange({
				...value,
				apiKey: e.target.value
			}),
			placeholder: "sk-…",
			autoComplete: "off"
		})] }),
		/* @__PURE__ */ jsxs("label", { children: [/* @__PURE__ */ jsx("span", { children: "Default model" }), /* @__PURE__ */ jsx("input", {
			type: "text",
			value: value.defaultModel,
			onChange: (e) => onChange({
				...value,
				defaultModel: e.target.value
			}),
			placeholder: defaultModelPlaceholder
		})] })
	] });
}
//#endregion
//#region src/client.tsx
/** Runtime services we depend on. The harness guarantees these are live by
*  the time apply() runs (per the dsh.client manifest in package.json). */
const inject = [
	"@deepseek-ai/dsh-client-runtime",
	"@deepseek-ai/dsh-client-ui-slots",
	"@deepseek-ai/dsh-client-modules"
];
/** Cache the React roots so HMR can unmount cleanly. */
const roots = /* @__PURE__ */ new Map();
/** Mount the infinite-canvas editor into a host element. Returns a disposer
*  that ReactDOM calls when the tab closes (unmount + cleanup). */
function mountCanvas(host) {
	let root = roots.get(host);
	if (!root) {
		root = createRoot(host);
		roots.set(host, root);
	}
	root.render(createElement(Canvas, { host }));
	return () => {
		root?.unmount();
		roots.delete(host);
	};
}
/** Mount the per-canvas settings form (apiKey, baseURL, model pickers). */
function mountSettings(host) {
	let root = roots.get(host);
	if (!root) {
		root = createRoot(host);
		roots.set(host, root);
	}
	root.render(createElement(SettingsPanel, { host }));
	return () => {
		root?.unmount();
		roots.delete(host);
	};
}
/**
* Client plugin entry. The harness calls this once per active DSH profile.
*
* Soft-deps on betterSidebar: if the user has not installed the sidebar
* plugin, we surface a settings panel only — the canvas tab is omitted
* (the agent can still drive the canvas through the chat UI).
*/
function apply(ctx) {
	const c = ctx;
	c.inject(["@deepseek-ai/dsh-client-ui-slots"], () => {
		const slots = c.get("@deepseek-ai/dsh-client-ui-slots");
		if (slots && typeof slots.registerSlot === "function") slots.registerSlot("media-studio-canvas", mountCanvas);
	});
	c.inject(["@deepseek-ai/dsh-client-ui-slots"], () => {
		const slots = c.get("@deepseek-ai/dsh-client-ui-slots");
		if (slots && typeof slots.registerSlot === "function") slots.registerSlot("media-studio-settings", mountSettings);
	});
}
//#endregion
export { apply, inject };

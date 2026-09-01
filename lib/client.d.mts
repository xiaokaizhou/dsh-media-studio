//#region src/client.d.ts
/** Runtime services we depend on. The harness guarantees these are live by
 *  the time apply() runs (per the dsh.client manifest in package.json). */
declare const inject: string[];
/**
 * Client plugin entry. The harness calls this once per active DSH profile.
 *
 * Soft-deps on betterSidebar: if the user has not installed the sidebar
 * plugin, we surface a settings panel only — the canvas tab is omitted
 * (the agent can still drive the canvas through the chat UI).
 */
declare function apply(ctx: unknown): void;
//#endregion
export { apply, inject };
import Schema from '@deepseek-ai/schemastery'

/**
 * Plugin-level config (the cordis.yml row). Holds ONLY values that
 * cannot live in the user-facing settings UI — typically filesystem
 * paths and boolean toggles a host admin owns. Everything user-tunable
 * (provider baseURL, API keys, model choice, voice) lives in the
 * `mediaStudio` settings namespace registered in `settings.ts` and is
 * surfaced to the DSH Settings page like any other plugin.
 *
 * Misconfiguration fails loud at load time (Schemastery), and every
 * field below is overrideable in cordis.yml without editing code.
 */
export interface Config {
  /** Where canvas snapshots, generated media, and SSE journal land. */
  workspaceRoot: string
  /**
   * Extra directories the `/api/media-studio/media-file` proxy may serve
   * from, on top of `workspaceRoot`. Needed whenever an agent parks
   * generated media in a project directory (e.g. a video project under
   * `~/Movies/<project>`) instead of the plugin workspace: without a
   * matching root the browser gets 403 and every image/video/music node
   * renders as "failed to load". Leading `~` is expanded.
   */
  mediaRoots: string[]
  /** Canvas every freshly opened session is bound to by default. */
  defaultCanvasId: string
  /** Send `MediaStudio/tool-call` events to the session log (replayable). */
  logToolCalls: boolean
  /** Cap for the "recently opened" project list (requirement: max 10). */
  recentLimit: number
  /** Deleting a project moves it under <workspaceRoot>/trash instead of
   *  hard-deleting it, unless the dialog explicitly opts into permanent. */
  trashEnabled: boolean
  /**
   * Base directory used as the default sourcePath for newly created projects
   * that don't receive an explicit sourcePath. Projects land under
   * <defaultSourcePath>/<projectName>/ instead of <wsRoot>/projects/<id>/.
   * Defaults to ~/Movies.
   */
  defaultSourcePath: string
}

export const Config: Schema<Config> = Schema.object({
  workspaceRoot: Schema.string().default('~/.media-studio').description('Directory for canvas + generated media. Created on first write.'),
  mediaRoots: Schema.array(Schema.string()).default(['~/Movies']).description('Extra directories the media-file proxy may serve from, on top of workspaceRoot. Use when generated media lives in a project folder (e.g. ~/Movies/my-film). Leading ~ is expanded. Defaults to ~/Movies so drama/film projects created with a sourcePath under ~/Movies render out of the box.'),
  defaultCanvasId: Schema.string().default('main').description('Canvas id every session is bound to unless it overrides.'),
  logToolCalls: Schema.boolean().default(true).description('Append every canvas/media tool result to the session log for replay.'),
  recentLimit: Schema.number().default(10).min(1).max(50).description('Max entries kept in the project "recently opened" list.'),
  trashEnabled: Schema.boolean().default(true).description('Deleted projects/assets move to <workspaceRoot>/trash (recoverable) unless permanent delete is explicitly requested.'),
  defaultSourcePath: Schema.string().default('~/Movies').description('Base directory for new projects without an explicit sourcePath. Projects land under <defaultSourcePath>/<name>/ instead of <wsRoot>/projects/<id>/.'),
})

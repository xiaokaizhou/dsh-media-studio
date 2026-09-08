// Minimal zh/en i18n for the media-studio UI chrome.
//
// Language resolution when wired to the host:
//   1) The DSH-wide `ctx.locale` service (Settings → Language row) is the
//      preferred source — that's the only switch a user can ever need, since
//      one DSH session is shared across tabs.
//   2) When running outside dsh-web (tests / standalone), useI18n() falls back
//      to a per-plugin localStorage key and the browser language, so a smoke
//      page can still render without ctx.locale mounted.
//
// Keys are added as features land; M4 sweeps the remaining legacy strings
// (add-node catalog, view bar, node menus) into this table so the whole UI
// chrome is covered.

export type Lang = 'zh' | 'en'

/** Shape the host's `ctx.locale` service exposes to the consumer. The
 *  concrete type is `LocaleRuntime` (see @deepseek-ai/dsh-client-locale),
 *  but the project entry avoids a hard import so the client bundle stays
 *  external to the locale module. */
export interface LocaleSource {
  getSnapshot(): { active: string; revision: number }
  subscribe(fn: () => void): () => void
  translate(ns: string, key: string, vars?: Record<string, string | number>): string
  register(
    ns: string,
    dicts: Record<Lang, Record<string, string>>,
  ): () => void
}

export const LOCALE_NS = 'media-studio'

const STORAGE_KEY = 'dsh-media-studio:lang'

const DICT = {
  zh: {
    'tab.title': '媒体工作室',
    'project.menu': '项目',
    'project.menu.title': '项目管理',
    'project.new': '新建项目',
    'project.open': '打开',
    'project.open.title': '打开项目',
    'project.open.empty': '还没有任何项目',
    'project.empty.title': '未打开项目',
    'project.empty.desc': '创建一个新项目，或从最近打开中选择一个项目开始工作',
    'project.empty.action': '新建项目',
    'project.open.local': '打开本地',
    'project.open.local.busy': '正在打开文件夹…',
    'project.revealInFolder': '在文件管理器中显示',
    'project.revealInFolder.busy': '正在打开文件管理器…',
    'project.revealInFolder.err': '无法打开文件管理器',
    'project.recent': '最近打开',
    'project.recent.title': '最近打开',
    'project.recent.empty': '暂无最近打开记录',
    'project.recent.clear': '清空最近记录',
    'project.current': '当前项目',
    'project.rename': '重命名',
    'project.delete': '删除',
    'project.name.placeholder': '输入项目名称…',
    'project.back': '返回',
    'project.legacy': '旧版画布',
    'project.created': '创建',
    'project.updated': '更新',
    'project.lang': '语言',
    'common.create': '创建',
    'common.cancel': '取消',
    'common.rename': '重命名',
    'common.delete': '删除',
    'common.close': '关闭',
    'common.loading': '处理中…',
    'common.error': '出错了',
    'dlg.rename.title': '重命名项目',
    'dlg.new.title': '新建项目',
    'dlg.delete.title': '删除项目',
    'dlg.delete.summary': '将删除项目「{name}」及其素材与画布。',
    'dlg.delete.trashHint': '默认移入回收站（可从磁盘恢复）；勾选「彻底删除」将跳过回收站。',
    'dlg.delete.permanent': '彻底删除（跳过回收站）',
    'dlg.delete.noRefs': '没有其他项目引用本项目素材，可以安全删除。',
    'dlg.delete.analyzing': '正在检查其他项目是否引用了本项目素材…',
    'dlg.delete.refsHeader': '以下项目引用了本项目的素材',
    'dlg.delete.refsDetail': '{project} · {nodes} 处引用',
    'dlg.delete.refsAssetHint': '删除后这些引用将失效。',
    'dlg.delete.cascadeHint': '选择处理方式后才能删除：',
    'dlg.delete.cascade.migrate': '将引用的素材迁入共享库后删除（推荐）',
    'dlg.delete.cascade.break': '强制删除，并把其他项目中的引用标记为「素材缺失」',
    'dlg.delete.copiesHint': '以下项目曾复制过本项目素材（独立副本，不受影响）：',
    'dlg.delete.blocked': '请先选择引用处理方式',
    'dlg.name.required': '请输入项目名称',
    'dlg.name.invalid': '名称不能包含 \\ / : * ? " < > | 字符',
    'dlg.name.long': '名称最长 64 个字符',
    'err.blocked.project': '该项目正被其他项目引用，已阻止删除。',
    'err.generic': '{message}',
    'dlg.delete.confirm': '删除项目',
    'dlg.migrate.ok': '已迁移 {migrated} 个素材到共享库',
    'dlg.break.ok': '已在 {broken} 处引用标记断链',
    'toast.done': '完成',
    'project.library': '素材库',
    'project.refresh': '刷新项目列表',
    'asset.all': '全部',
    'asset.title': '素材库 · {project}',
    'asset.kind.character': '人物资产',
    'asset.kind.scene': '场景资产',
    'asset.kind.audio': '音频资产',
    'asset.kind.clip': '视频片段',
    'asset.empty': '本项目素材库还是空的',
    'asset.empty.hint': '把画布上的媒体卡片「存入素材库」，就能跨项目搜索复用了',
    'asset.size': '{bytes} KB',
    'asset.fromCanvas': '来自画布',
    'asset.copied': '副本',
    'asset.copyTo': '复制到…',
    'asset.copy.self': '不能复制到本项目',
    'asset.rename': '重命名',
    'asset.delete': '删除',
    'asset.sync': '从画布同步',
    'asset.delete.confirm': '删除素材',
    'asset.delete.blocked': '该素材被 {n} 个项目的 {refs} 处引用',
    'asset.delete.cascadeHint': '处理方式：',
    'asset.cascade.migrate': '迁入共享库（引用保留）',
    'asset.cascade.break': '删除并在引用处断链',
    'asset.delete.progress': '删除后该素材将移出项目（文件入回收站），引用方需处理。',
    'save.title': '存入素材库',
    'save.name.placeholder': '素材名称（默认取卡片标题）',
    'save.confirm': '存入',
    'save.hint': '文件将复制进当前项目的素材库，画布卡片保持不变。',
    'node.saveToLibrary': '存入素材库',

    'search.placeholder': '搜索素材（⌘K）',
    'search.current': '当前项目 · {name}',
    'search.other': '其他 {n} 个项目',
    'search.noResult': '未找到与「{q}」相关的素材',
    'search.idle': '搜索素材库与画布（输入关键词）',
    'search.refCount': '已引用 {n}',
    'search.canvasTag': '画布素材',
    'search.addRef': '添加',
    'search.importCopy': '复制入库',
    'search.addedRef': '已在画布添加引用',
    'search.imported': '已复制到本项目素材库',
    'search.close': '关闭（Esc）',
    'asset.register.ok': '已存入素材库',
    'asset.register.dup': '该卡片此前已存入素材库',
    'asset.copy.ok': '已复制到「{project}」',
    'asset.synced.ok': '素材文件已从画布同步',
    'view.autoArrange': '自动排列节点',
    'view.adaptiveAutoArrange': '按分区自适应排列',
    'view.minimap.show': '显示小地图',
    'view.minimap.hide': '隐藏小地图',
    'view.fit': '适应内容',
    'view.clear': '清空画布',
    'view.clear.confirm': '确定要清空当前画布吗？此操作不可撤销。',
    'view.zoomIn': '放大',
    'view.zoomOut': '缩小',
    'view.zoomReset': '重置缩放',
    'export.title': '导出画布为 PNG 图片',
    'export.loading': '导出中…',
  },
  en: {
    'tab.title': 'Media Studio',
    'project.menu': 'Project',
    'project.menu.title': 'Projects',
    'project.new': 'New Project',
    'project.open': 'Open',
    'project.open.title': 'Open Project',
    'project.open.empty': 'No projects yet',
    'project.empty.title': 'No project open',
    'project.empty.desc': 'Create a new project or open one from recent projects to get started',
    'project.empty.action': 'New Project',
    'project.open.local': 'Open local folder…',
    'project.open.local.busy': 'Opening folder…',
    'project.revealInFolder': 'Show in file manager',
    'project.revealInFolder.busy': 'Opening file manager…',
    'project.revealInFolder.err': 'Could not open file manager',
    'project.recent': 'Recent',
    'project.recent.title': 'Recent Projects',
    'project.recent.empty': 'No recent projects',
    'project.recent.clear': 'Clear recent list',
    'project.current': 'Current project',
    'project.rename': 'Rename',
    'project.delete': 'Delete',
    'project.name.placeholder': 'Project name…',
    'project.back': 'Back',
    'project.legacy': 'Legacy canvas',
    'project.created': 'Created',
    'project.updated': 'Updated',
    'project.lang': 'Language',
    'common.create': 'Create',
    'common.cancel': 'Cancel',
    'common.rename': 'Rename',
    'common.delete': 'Delete',
    'common.close': 'Close',
    'common.loading': 'Working…',
    'common.error': 'Error',
    'dlg.rename.title': 'Rename project',
    'dlg.new.title': 'New project',
    'dlg.delete.title': 'Delete project',
    'dlg.delete.summary': 'This will delete project “{name}” with its assets and canvas.',
    'dlg.delete.trashHint': 'Moved to the trash by default (recoverable from disk); check “delete permanently” to skip the trash.',
    'dlg.delete.permanent': 'Delete permanently (skip trash)',
    'dlg.delete.noRefs': 'No other project references this project’s assets — safe to delete.',
    'dlg.delete.analyzing': 'Checking other projects for references to this project’s assets…',
    'dlg.delete.refsHeader': 'Projects referencing this project’s assets',
    'dlg.delete.refsDetail': '{project} · {nodes} reference(s)',
    'dlg.delete.refsAssetHint': 'These references would break on deletion.',
    'dlg.delete.cascadeHint': 'Pick how to handle them before deleting:',
    'dlg.delete.cascade.migrate': 'Move referenced assets to the shared library, then delete (recommended)',
    'dlg.delete.cascade.break': 'Force delete and mark referencing nodes as “asset missing”',
    'dlg.delete.copiesHint': 'Projects that hard-copied assets from this project (independent copies, unaffected):',
    'dlg.delete.blocked': 'Choose how to handle references first',
    'dlg.name.required': 'A project name is required',
    'dlg.name.invalid': 'Name may not contain \\ / : * ? " < > | characters',
    'dlg.name.long': 'Name must be at most 64 characters',
    'err.blocked.project': 'This project is referenced by other projects; deletion was blocked.',
    'err.generic': '{message}',
    'dlg.delete.confirm': 'Delete project',
    'dlg.migrate.ok': 'Migrated {migrated} asset(s) to the shared library',
    'dlg.break.ok': 'Marked {broken} reference(s) as broken',
    'toast.done': 'Done',
    'project.library': 'Asset Library',
    'project.refresh': 'Refresh project list',
    'asset.all': 'All',
    'asset.title': 'Asset Library · {project}',
    'asset.kind.character': 'Characters',
    'asset.kind.scene': 'Scenes',
    'asset.kind.audio': 'Audio',
    'asset.kind.clip': 'Video clips',
    'asset.empty': 'This project has no assets yet',
    'asset.empty.hint': 'Save a canvas media card to the library to reuse it across projects',
    'asset.size': '{bytes} KB',
    'asset.fromCanvas': 'From canvas',
    'asset.copied': 'Copy',
    'asset.copyTo': 'Copy to…',
    'asset.copy.self': 'Cannot copy into the same project',
    'asset.rename': 'Rename',
    'asset.delete': 'Delete',
    'asset.sync': 'Sync from canvas',
    'asset.delete.confirm': 'Delete asset',
    'asset.delete.blocked': 'This asset is referenced by {n} project(s) ({refs} references)',
    'asset.delete.cascadeHint': 'Handle references:',
    'asset.cascade.migrate': 'Move to shared library (references stay)',
    'asset.cascade.break': 'Delete and break referencing nodes',
    'asset.delete.progress': 'The asset leaves the project (file to trash); referencing projects must be handled.',
    'save.title': 'Save to Library',
    'save.name.placeholder': 'Asset name (defaults to the card title)',
    'save.confirm': 'Save',
    'save.hint': 'A copy of the file is stored in the current project library; the canvas card stays unchanged.',
    'node.saveToLibrary': 'Save to library',

    'search.placeholder': 'Search assets (⌘K)',
    'search.current': 'Current project · {name}',
    'search.other': '{n} other project(s)',
    'search.noResult': 'No assets matching “{q}”',
    'search.idle': 'Search libraries and canvases…',
    'search.refCount': '{n} reference(s)',
    'search.canvasTag': 'Canvas',
    'search.addRef': 'Add',
    'search.importCopy': 'Copy in',
    'search.addedRef': 'Reference added to the canvas',
    'search.imported': 'Copied into this project’s library',
    'search.close': 'Close (Esc)',
    'asset.register.ok': 'Saved to the library',
    'asset.register.dup': 'This card was already saved to the library',
    'asset.copy.ok': 'Copied to “{project}”',
    'asset.synced.ok': 'Asset file synced from canvas',
    'view.autoArrange': 'Auto-arrange nodes by flow',
    'view.adaptiveAutoArrange': 'Adaptive arrange by region',
    'view.minimap.show': 'Show minimap',
    'view.minimap.hide': 'Hide minimap',
    'view.fit': 'Fit to content',
    'view.clear': 'Clear canvas',
    'view.clear.confirm': 'Are you sure you want to clear the current canvas? This action cannot be undone.',
    'view.zoomIn': 'Zoom in',
    'view.zoomOut': 'Zoom out',
    'view.zoomReset': 'Reset zoom',
    'export.title': 'Export canvas as PNG image',
    'export.loading': 'Exporting…',
  },
} as const

export type StrKey = keyof typeof DICT.zh

export function resolveLang(): Lang {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved === 'zh' || saved === 'en') return saved
  } catch { /* storage unavailable */ }
  try {
    return typeof navigator !== 'undefined' && /^zh\b/i.test(navigator.language) ? 'zh' : 'en'
  } catch {
    return 'zh'
  }
}

export function storeLang(lang: Lang): void {
  try {
    localStorage.setItem(STORAGE_KEY, lang)
  } catch { /* ignore */ }
}

/** Normalize an arbitrary locale id (zh-CN / en-US / ...) to the shipped
 *  zh|en pair. Anything not starting with `zh` falls back to `en`. */
export function normalizeLang(id: string | undefined | null): Lang {
  if (typeof id !== 'string') return 'zh'
  return /^zh\b/i.test(id) ? 'zh' : 'en'
}

/** Direct translation lookup used when no LocaleSource is available
 *  (tests / standalone previews). Identical signature to the host's
 *  LocaleRuntime.translate() so call sites can pick at runtime. */
export function translate(lang: Lang, key: string, vars?: Record<string, string | number>): string {
  const table = DICT[lang] as Record<string, string>
  let s = table[key] ?? (DICT.en as Record<string, string>)[key] ?? key
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      s = s.replaceAll(`{${k}}`, String(v))
    }
  }
  return s
}

// Idempotency guard for the host LocaleRuntime. Two layers:
//   1. Module-level cache — repeated applies of the SAME module instance
//      reuse the first registration.
//   2. Window-level flag — the DSH web runtime hot-reloads a plugin's client
//      bundle by re-executing the module, which resets module state while
//      the host LocaleRuntime keeps the dictionaries registered by the
//      previous instance. A module-level cache alone then misses, and the
//      second `register()` throws `locale namespace "media-studio" already
//      has locale "zh"`. The window flag makes every module instance agree
//      that the dictionaries are already registered and stay quiet.
let registered: { source: LocaleSource; dispose: () => void } | null = null

const GLOBAL_FLAG = '__dshMediaStudioLocaleRegistered'

// `globalThis` instead of `window`: this module is also type-checked under
// the root tsconfig's ES2022-only lib (no DOM), where `window` is undeclared;
// in the browser globalThis IS the window object, so the flag is shared
// across hot-reloaded module instances the same way.
//
// The flag stores the LocaleSource instance (not a boolean): a hot reload
// re-registers against the SAME host instance, so comparing identities lets
// us skip only that case while different host instances still register.
function readGlobalFlag(): unknown {
  try {
    return (globalThis as Record<string, unknown>)[GLOBAL_FLAG]
  } catch {
    return undefined
  }
}

function clearGlobalFlag(source: LocaleSource): void {
  try {
    if ((globalThis as Record<string, unknown>)[GLOBAL_FLAG] === source) {
      delete (globalThis as Record<string, unknown>)[GLOBAL_FLAG]
    }
  } catch { /* ignore */ }
}

/** Register the media-studio dictionaries into a host LocaleSource under
 *  the {@link LOCALE_NS} namespace. Safe to call multiple times against the
 *  same host (repeated calls are idempotent no-ops that reuse the first
 *  registration, across module reloads too); the disposer is returned for
 *  ctx.effect wiring. The fallback path (no LocaleSource) is a no-op. */
export function registerLocaleDictionaries(source: LocaleSource | undefined | null): () => void {
  if (!source) return () => {}
  if (registered?.source === source) {
    // Already registered against this host instance — nothing to do.
    return registered.dispose
  }
  if (readGlobalFlag() === source) {
    // A previous module instance (hot reload / duplicate bundle) already
    // holds the registration on this SAME host — keep quiet instead of
    // re-registering and letting the host throw on the duplicate.
    return () => {}
  }
  try {
    const dispose = source.register(LOCALE_NS, { zh: DICT.zh as Record<string, string>, en: DICT.en as Record<string, string> })
    ;(globalThis as Record<string, unknown>)[GLOBAL_FLAG] = source
    // The wrapped disposer doubles as the cached value, so repeated calls
    // against the same host return the exact same function reference.
    const wrap = (): void => {
      // Only clear the cache when this exact registration is disposed, so a
      // later re-apply can register fresh if the first one was torn down.
      if (registered?.source === source) registered = null
      clearGlobalFlag(source)
      dispose()
    }
    registered = { source, dispose: wrap }
    return wrap
  } catch (e) {
    // Duplicate (ns, locale) is the only realistic failure here — we keep
    // the dictionaries on the first call; second callers stay silent rather
    // than tearing the page down at boot.
    console.warn('[media-studio] registerLocaleDictionaries failed:', (e as Error).message)
    return () => {}
  }
}

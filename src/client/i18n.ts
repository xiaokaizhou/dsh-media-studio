// Minimal zh/en i18n for the media-studio UI chrome.
//
// Language resolution: localStorage `dsh-media-studio:lang` override wins,
// else the browser language (zh-* → zh, otherwise en). Components subscribe
// through useI18n() so a runtime switch (project menu footer) re-renders.
//
// Keys are added as features land; M4 sweeps the remaining legacy strings
// (add-node catalog, view bar, node menus) into this table so the whole UI
// chrome is covered.

export type Lang = 'zh' | 'en'

const STORAGE_KEY = 'dsh-media-studio:lang'

const DICT = {
  zh: {
    'project.menu': '项目',
    'project.menu.title': '项目管理',
    'project.new': '新建项目',
    'project.open': '打开',
    'project.open.title': '打开项目',
    'project.open.empty': '还没有任何项目',
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
    'hist.title': '版本历史',
    'hist.play': '播放历史',
    'hist.pause': '暂停',
    'hist.progress': '进度',
    'hist.none': '暂无历史版本',
    'hist.backToLive': '回到最新',
    'asset.register.ok': '已存入素材库',
    'asset.register.dup': '该卡片此前已存入素材库',
    'asset.copy.ok': '已复制到「{project}」',
    'asset.synced.ok': '素材文件已从画布同步',
  },
  en: {
    'project.menu': 'Project',
    'project.menu.title': 'Projects',
    'project.new': 'New Project',
    'project.open': 'Open',
    'project.open.title': 'Open Project',
    'project.open.empty': 'No projects yet',
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
    'hist.title': 'Version history',
    'hist.play': 'Play history',
    'hist.pause': 'Pause',
    'hist.progress': 'Progress',
    'hist.none': 'No versions yet',
    'hist.backToLive': 'Back to live',
    'asset.register.ok': 'Saved to the library',
    'asset.register.dup': 'This card was already saved to the library',
    'asset.copy.ok': 'Copied to “{project}”',
    'asset.synced.ok': 'Asset file synced from canvas',
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

/** Translate a key with optional {placeholders}. Safe fallback to the key. */
export function translate(lang: Lang, key: string, vars?: Record<string, string | number>): string {
  const table = DICT[lang] as Record<string, string>
  let s = table[key] ?? (DICT.zh as Record<string, string>)[key] ?? key
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      s = s.replaceAll(`{${k}}`, String(v))
    }
  }
  return s
}

/** Locale bundles for the Media Studio settings card. */

/** Keys used by the card and its copy. */
export type MediaStudioLocaleKey =
  | 'title'
  | 'description'
  | 'textModel'
  | 'textModelHint'
  | 'imageProvider'
  | 'imageProviderHint'
  | 'imageBaseUrl'
  | 'imageBaseUrlHint'
  | 'imageApiKey'
  | 'imageApiKeyHint'
  | 'imageApiKeySet'
  | 'imageApiKeyUnset'
  | 'imageDefaultModel'
  | 'imageDefaultModelHint'
  | 'videoProvider'
  | 'videoProviderHint'
  | 'videoBaseUrl'
  | 'videoBaseUrlHint'
  | 'videoApiKey'
  | 'videoApiKeyHint'
  | 'videoApiKeySet'
  | 'videoApiKeyUnset'
  | 'videoDefaultModel'
  | 'videoDefaultModelHint'
  | 'musicProvider'
  | 'musicProviderHint'
  | 'musicBaseUrl'
  | 'musicBaseUrlHint'
  | 'musicApiKey'
  | 'musicApiKeyHint'
  | 'musicApiKeySet'
  | 'musicApiKeyUnset'
  | 'musicDefaultModel'
  | 'musicDefaultModelHint'
  | 'musicVoice'
  | 'musicVoiceHint'
  | 'overridden'
  | 'reset'
  | 'invalidText'
  | 'unsaved'
  | 'readOnly'
  | 'saveFailed'
  | 'save'
  | 'saving'
  | 'discard'
  | 'expand'
  | 'collapse'
  | 'configured'
  | 'notConfigured'

/** English copy. */
export const EN: Record<MediaStudioLocaleKey, string> = {
  title: 'Media Studio',
  description: 'Configure LLM (text) and media providers (image / video / voice). Keys stay on this machine.',
  textModel: 'Default text model',
  textModelHint: 'e.g. deepseek/deepseek-chat. Leave blank to auto-pick from DSH config.',
  imageProvider: 'Image provider id',
  imageProviderHint: 'e.g. custom-agnes',
  imageBaseUrl: 'Image API base URL',
  imageBaseUrlHint: 'Leave blank to use the default endpoint.',
  imageApiKey: 'Image API key',
  imageApiKeyHint: 'Stored outside the settings file. Leave blank to keep the current key.',
  imageApiKeySet: 'A key is configured.',
  imageApiKeyUnset: 'No key configured.',
  imageDefaultModel: 'Image default model',
  imageDefaultModelHint: 'e.g. agnes-image-2.1-flash',
  videoProvider: 'Video provider id',
  videoProviderHint: 'e.g. custom-agnes',
  videoBaseUrl: 'Video API base URL',
  videoBaseUrlHint: 'Leave blank to use the default endpoint.',
  videoApiKey: 'Video API key',
  videoApiKeyHint: 'Stored outside the settings file. Leave blank to keep the current key.',
  videoApiKeySet: 'A key is configured.',
  videoApiKeyUnset: 'No key configured.',
  videoDefaultModel: 'Video default model',
  videoDefaultModelHint: 'e.g. agnes-video-2.5-flash',
  musicProvider: 'Music/TTS provider id',
  musicProviderHint: 'e.g. custom-minimax',
  musicBaseUrl: 'Music API base URL',
  musicBaseUrlHint: 'Leave blank to use the default endpoint.',
  musicApiKey: 'Music API key',
  musicApiKeyHint: 'Stored outside the settings file. Leave blank to keep the current key.',
  musicApiKeySet: 'A key is configured.',
  musicApiKeyUnset: 'No key configured.',
  musicDefaultModel: 'Music default model',
  musicDefaultModelHint: 'e.g. speech-02-hd',
  musicVoice: 'Default voice',
  musicVoiceHint: 'Voice preset id for TTS, e.g. male-qn-jingying',
  overridden: 'Overridden',
  reset: 'Reset',
  invalidText: 'Enter a value.',
  unsaved: 'Unsaved',
  readOnly: 'This deployment stores settings read-only.',
  saveFailed: 'The deployment did not accept these values; they were left for you to correct.',
  save: 'Save',
  saving: 'Saving…',
  discard: 'Discard',
  expand: 'Expand',
  collapse: 'Collapse',
  configured: 'configured',
  notConfigured: 'not configured',
}

/** Simplified Chinese copy (same keys as en). */
export const zh: Record<MediaStudioLocaleKey, string> = {
  title: '媒体工作室',
  description: '配置 LLM（文本）和媒体提供方（图片 / 视频 / 语音）。密钥仅保存在本机。',
  textModel: '默认文本模型',
  textModelHint: '例如 deepseek/deepseek-chat，留空则自动选择 DSH 配置的模型。',
  imageProvider: '图片提供方 ID',
  imageProviderHint: '例如 custom-agnes',
  imageBaseUrl: '图片 API 基础地址',
  imageBaseUrlHint: '留空则使用默认地址。',
  imageApiKey: '图片 API 密钥',
  imageApiKeyHint: '不写入设置文件。留空表示保持当前密钥。',
  imageApiKeySet: '已配置密钥。',
  imageApiKeyUnset: '未配置密钥。',
  imageDefaultModel: '图片默认模型',
  imageDefaultModelHint: '例如 agnes-image-2.1-flash',
  videoProvider: '视频提供方 ID',
  videoProviderHint: '例如 custom-agnes',
  videoBaseUrl: '视频 API 基础地址',
  videoBaseUrlHint: '留空则使用默认地址。',
  videoApiKey: '视频 API 密钥',
  videoApiKeyHint: '不写入设置文件。留空表示保持当前密钥。',
  videoApiKeySet: '已配置密钥。',
  videoApiKeyUnset: '未配置密钥。',
  videoDefaultModel: '视频默认模型',
  videoDefaultModelHint: '例如 agnes-video-2.5-flash',
  musicProvider: '音乐/TTS 提供方 ID',
  musicProviderHint: '例如 custom-minimax',
  musicBaseUrl: '音乐 API 基础地址',
  musicBaseUrlHint: '留空则使用默认地址。',
  musicApiKey: '音乐 API 密钥',
  musicApiKeyHint: '不写入设置文件。留空表示保持当前密钥。',
  musicApiKeySet: '已配置密钥。',
  musicApiKeyUnset: '未配置密钥。',
  musicDefaultModel: '音乐默认模型',
  musicDefaultModelHint: '例如 speech-02-hd',
  musicVoice: '默认语音',
  musicVoiceHint: 'TTS 语音预设 ID，例如 male-qn-jingying',
  overridden: '已覆盖',
  reset: '恢复默认',
  invalidText: '请输入有效值。',
  unsaved: '未保存',
  readOnly: '本部署的设置为只读。',
  saveFailed: '本部署没有接受这些值，已保留供你修改。',
  save: '保存',
  saving: '保存中…',
  discard: '放弃修改',
  expand: '展开',
  collapse: '折叠',
  configured: '已配置',
  notConfigured: '未配置',
}

// Shared react binding over the tiny zh/en i18n table.
//
// When a host LocaleSource is provided (the DSH web app's `ctx.locale`),
// `useI18n` subscribes to its snapshot so the whole UI follows the Settings
// → Language row. Without one (tests / standalone previews) it falls back
// to the localStorage `dsh-media-studio:lang` override, then the browser
// language, so smoke renders still produce readable strings.

import { useCallback, useEffect, useState } from 'react'
import {
  LOCALE_NS,
  normalizeLang,
  resolveLang,
  storeLang,
  translate,
  type Lang,
  type LocaleSource,
} from './i18n'

export interface I18n {
  lang: Lang
  t: (key: string, vars?: Record<string, string | number>) => string
  /** Available only when a host LocaleSource is wired. Callers should
   *  feature-detect before binding; the project menu footer used to expose
   *  zh/en buttons but those were removed so this is only consumed by tests
   *  and external tools. */
  switchLang?: (l: Lang) => void
}

export function useI18n(locale?: LocaleSource | null): I18n {
  // Host LocaleSource present: subscribe to its snapshot so language
  // changes from Settings → Language re-render every subscriber. Without
  // it we fall back to localStorage + browser language.
  const [lang, setLang] = useState<Lang>(() =>
    locale ? normalizeLang(locale.getSnapshot().active) : resolveLang(),
  )
  useEffect(() => {
    if (!locale) return
    const sync = () => setLang(normalizeLang(locale.getSnapshot().active))
    sync()
    return locale.subscribe(sync)
  }, [locale])

  const t = useCallback(
    (key: string, vars?: Record<string, string | number>) => {
      if (locale) return locale.translate(LOCALE_NS, key, vars)
      return translate(lang, key, vars)
    },
    [locale, lang],
  )

  // Without a host LocaleSource we still let the user toggle through the
  // legacy localStorage key (kept for standalone previews / tests). With
  // one, switching must go through `ctx.locale.setLocale(...)` — we don't
  // expose that here because the project menu no longer surfaces the
  // buttons; external code that needs to flip the language should reach
  // into the LocaleSource directly.
  const switchLang = locale
    ? undefined
    : useCallback((next: Lang) => {
        storeLang(next)
        setLang(next)
      }, [])

  return { lang, t, switchLang }
}

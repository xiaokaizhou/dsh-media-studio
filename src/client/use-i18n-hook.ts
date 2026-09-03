// Shared react binding over the tiny zh/en i18n table. Language switches
// (stored in localStorage) re-render every subscriber via local state.

import { useCallback, useState } from 'react'
import { resolveLang, storeLang, translate, type Lang } from './i18n'

export interface I18n {
  lang: Lang
  t: (key: string, vars?: Record<string, string | number>) => string
  switchLang: (l: Lang) => void
}

export function useI18n(): I18n {
  const [lang, setLang] = useState<Lang>(resolveLang())
  const t = useCallback(
    (key: string, vars?: Record<string, string | number>) => translate(lang, key, vars),
    [lang],
  )
  const switchLang = useCallback((next: Lang) => {
    storeLang(next)
    setLang(next)
  }, [])
  return { lang, t, switchLang }
}

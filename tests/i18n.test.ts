import { describe, it, expect, vi, afterEach } from 'vitest'
import { registerLocaleDictionaries, type LocaleSource } from '../src/client/i18n'

/**
 * Regression tests for the locale-dictionary registration lifecycle.
 *
 * Failure mode being guarded (seen in the dsh web console at boot):
 *   [Warning] [media-studio] registerLocaleDictionaries failed: locale
 *   namespace "media-studio" already has locale "zh"
 * The host LocaleRuntime rejects a duplicate (ns, locale) registration with
 * a throw, and the DSH client runtime may re-apply a plugin against the SAME
 * host instance. registerLocaleDictionaries must therefore be idempotent per
 * host instance instead of re-registering (and throwing) on every apply.
 */

/** Minimal host-like LocaleRuntime with the real duplicate-rejection
 *  semantics: registering an existing (ns, locale) throws. */
function makeSource(): LocaleSource & { regCalls: number } {
  const dicts = new Map<string, Map<string, Record<string, string>>>()
  const source = {
    regCalls: 0,
    getSnapshot: () => ({ active: 'zh', revision: 0 }),
    subscribe: () => () => {},
    translate: (_ns: string, key: string) => key,
    register(ns: string, dicts_: Record<string, Record<string, string>>): () => void {
      this.regCalls += 1
      let locales = dicts.get(ns)
      if (!locales) {
        locales = new Map()
        dicts.set(ns, locales)
      }
      for (const locale of Object.keys(dicts_)) {
        if (locales.has(locale)) throw new Error(`locale namespace "${ns}" already has locale "${locale}"`)
      }
      for (const [locale, entries] of Object.entries(dicts_)) locales.set(locale, entries)
      return () => {
        for (const locale of Object.keys(dicts_)) locales.delete(locale)
      }
    },
  }
  return source
}

describe('registerLocaleDictionaries', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    // The shared registration flag lives on globalThis (browser: window);
    // clear it so a leaked flag from one test cannot skew the next.
    delete (globalThis as Record<string, unknown>)['__dshMediaStudioLocaleRegistered']
  })

  it('registers zh/en dictionaries on first call and returns a disposer', () => {
    const s = makeSource()
    const dispose = registerLocaleDictionaries(s)
    expect(s.regCalls).toBe(1)
    expect(typeof dispose).toBe('function')
    dispose()
  })

  it('is idempotent against the same host instance — no duplicate-register throw', () => {
    const s = makeSource()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const d1 = registerLocaleDictionaries(s)
    const d2 = registerLocaleDictionaries(s)
    // Second apply against the same host must reuse the first registration.
    expect(s.regCalls).toBe(1)
    expect(d2).toBe(d1)
    expect(warn).not.toHaveBeenCalled()
    d1()
  })

  it('re-registers after the first registration has been disposed', () => {
    const s = makeSource()
    const d1 = registerLocaleDictionaries(s)
    d1()
    const d2 = registerLocaleDictionaries(s)
    expect(s.regCalls).toBe(2)
    d2()
  })

  it('registers independently for different host instances', () => {
    const a = makeSource()
    const b = makeSource()
    const da = registerLocaleDictionaries(a)
    const db = registerLocaleDictionaries(b)
    expect(a.regCalls).toBe(1)
    expect(b.regCalls).toBe(1)
    da()
    db()
  })

  it('is a no-op when no LocaleSource is available', () => {
    const dispose = registerLocaleDictionaries(null)
    expect(typeof dispose).toBe('function')
    dispose()
  })

  it('sets and clears the shared global flag across register/dispose', () => {
    const s = makeSource()
    const d1 = registerLocaleDictionaries(s)
    expect(s.regCalls).toBe(1)
    expect((globalThis as Record<string, unknown>)['__dshMediaStudioLocaleRegistered']).toBe(s)
    d1()
    expect((globalThis as Record<string, unknown>)['__dshMediaStudioLocaleRegistered']).toBeUndefined()
  })

  it('stays quiet when another module instance registered the SAME host (global flag)', () => {
    // Simulates a client-bundle hot reload: the module re-executes (its
    // module-level `registered` cache is lost) but the host LocaleRuntime —
    // and the shared global flag — survive. The fresh call must not
    // re-register (which would make the host throw on the duplicate).
    const s = makeSource()
    ;(globalThis as Record<string, unknown>)['__dshMediaStudioLocaleRegistered'] = s
    try {
      const d = registerLocaleDictionaries(s)
      expect(s.regCalls).toBe(0) // must not register again
      d()
    } finally {
      delete (globalThis as Record<string, unknown>)['__dshMediaStudioLocaleRegistered']
    }
  })
})

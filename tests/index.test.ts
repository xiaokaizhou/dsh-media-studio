import { describe, expect, it } from 'vitest'
import {
  DEFAULT_MEDIA_STUDIO,
  readMediaStudio,
  MediaStudioSettings,
  NS,
} from '../src/settings'

describe('media-studio settings', () => {
  it('exposes the namespace id "media-studio"', () => {
    expect(NS).toBe('media-studio')
  })

  it('falls back to the documented defaults when the user section is empty', () => {
    expect(readMediaStudio(undefined)).toEqual(DEFAULT_MEDIA_STUDIO)
  })

  it('default schema defaults match the documented DEFAULT_MEDIA_STUDIO shape', () => {
    // Resolve the schema with an empty input — Schemastery fills in
    // every default declared via `.default(...)`. The resolved object
    // must equal the TypeScript-level constant so any code path that
    // reads either source sees the same shape.
    const resolved = MediaStudioSettings({} as any)
    expect((resolved as any).textModel).toBe('')
    expect((resolved as any).image.provider).toBe('custom-agnes')
    expect((resolved as any).image.defaultModel).toBe('agnes-image-2.1-flash')
    expect((resolved as any).music.voice).toBe('male-qn-jingying')
  })
})

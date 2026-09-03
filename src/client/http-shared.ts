// Tiny shared REST helper for the media-studio client (browser-side).
// ok:false instead of throwing so UIs render inline errors.

export interface Ok<T> { ok: true; data: T }
export interface Err { ok: false; error: string; code?: string }
export type ApiResult<T> = Ok<T> | Err

export async function requestJson<T>(path: string, init?: RequestInit): Promise<ApiResult<T>> {
  try {
    const res = await fetch(path, {
      headers: { 'Content-Type': 'application/json' },
      ...init,
    })
    let body: Record<string, unknown> = {}
    try { body = (await res.json()) as Record<string, unknown> } catch { /* non-json */ }
    if (!res.ok || body.ok === false) {
      return {
        ok: false,
        error: typeof body.error === 'string' ? body.error : `HTTP ${res.status}`,
        code: typeof body.code === 'string' ? body.code : undefined,
      }
    }
    return { ok: true, data: body as unknown as T }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

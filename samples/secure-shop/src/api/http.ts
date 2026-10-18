// Every request to the backend goes through here: the access token (A3), renewing it once on a 401 (A4, C20),
// the CSRF header on changes (C17), cookies always sent (A1, A2), and logging out when nothing works.

const TOKEN_KEY = 'shop.accessToken'

export const tokens = {
  get: () => localStorage.getItem(TOKEN_KEY),
  set: (t: string) => localStorage.setItem(TOKEN_KEY, t),
  clear: () => localStorage.removeItem(TOKEN_KEY),
}

let csrf: string | undefined
/** Called when the session can't be renewed: the app logs out and goes to /login. */
export let onLoggedOut: () => void = () => {}
export const whenLoggedOut = (fn: () => void) => (onLoggedOut = fn)

export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

async function refresh(): Promise<boolean> {
  const res = await fetch('/api/refresh', { method: 'POST', credentials: 'include' })
  if (!res.ok) return false
  const { accessToken } = (await res.json()) as { accessToken: string }
  tokens.set(accessToken)
  return true
}

export async function request<T>(path: string, init: RequestInit = {}, retry = true): Promise<T> {
  const headers = new Headers(init.headers)
  const token = tokens.get()
  if (token) headers.set('Authorization', `Bearer ${token}`)
  if (init.method && init.method !== 'GET') {
    csrf ??= ((await (await fetch('/api/csrf', { credentials: 'include' })).json()) as { csrfToken: string }).csrfToken
    headers.set('X-CSRF-Token', csrf)
  }
  if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json')
  const res = await fetch(path, { ...init, headers, credentials: 'include' })
  if (res.status === 401 && retry) {
    if (await refresh()) return request<T>(path, init, false)
    tokens.clear()
    onLoggedOut()
  }
  if (!res.ok) throw new HttpError(res.status, ((await res.json().catch(() => ({}))) as { error?: string }).error ?? res.statusText)
  return (await res.json()) as T
}

export const getJson = <T>(path: string) => request<T>(path)
export const postJson = <T>(path: string, body?: unknown) => request<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) })

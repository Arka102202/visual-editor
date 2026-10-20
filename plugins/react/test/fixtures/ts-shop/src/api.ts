const BASE = import.meta.env.VITE_API ?? ''
export async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`)
  return res.json() as Promise<T>
}

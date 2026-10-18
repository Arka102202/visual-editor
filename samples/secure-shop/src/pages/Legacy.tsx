// A6: an old internal endpoint behind HTTP Basic auth (ops / ops).
import { useState } from 'react'
import type { Health } from '@/types'

export function Legacy() {
  const [health, setHealth] = useState<Health | null>(null)
  const check = () => fetch('/api/legacy/health', { headers: { Authorization: `Basic ${btoa('ops:ops')}` } }).then((r) => r.json() as Promise<Health>).then(setHealth)
  return (
    <main>
      <h1>Ops</h1>
      <button onClick={check}>Check health</button>
      {health && <p>{health.status} · up {Math.round(health.uptimeSeconds / 3600)} h</p>}
    </main>
  )
}

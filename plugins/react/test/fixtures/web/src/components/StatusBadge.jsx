import { useEffect, useState } from 'react'

export function StatusBadge() {
  const [up, setUp] = useState(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    fetch('http://localhost:4000/api/health').then((r) => setUp(r.ok)).catch(() => setFailed(true))
  }, [])
  if (failed) return <span>Status unknown</span>
  return <span>{up ? 'Online' : 'Checking…'}</span>
}

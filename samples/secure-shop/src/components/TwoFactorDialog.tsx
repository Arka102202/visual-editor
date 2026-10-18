// A10: a second factor, asked only before a sensitive action.
import { useState } from 'react'
import { postJson } from '@/api/http'

export function TwoFactorDialog({ open, onPassed, onCancel }: { open: boolean; onPassed: () => void; onCancel: () => void }) {
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | null>(null)
  if (!open) return null
  return (
    <dialog open>
      <p>Enter the code from your authenticator app (demo: 123456).</p>
      <input value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" />
      {error && <p className="error">{error}</p>}
      <button onClick={() => postJson('/api/2fa/verify', { code }).then(onPassed, (e: Error) => setError(e.message))}>Verify</button>
      <button onClick={onCancel}>Cancel</button>
    </dialog>
  )
}

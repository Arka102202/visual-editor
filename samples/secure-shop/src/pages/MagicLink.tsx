// A9: passwordless login with a one-time code.
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { postJson } from '@/api/http'
import { useAuth } from '@/auth/AuthContext'

export function MagicLink() {
  const { loginWithCode } = useAuth()
  const navigate = useNavigate()
  const [email, setEmail] = useState('staff@example.com')
  const [sent, setSent] = useState<string | null>(null)
  const [code, setCode] = useState('')
  return (
    <main>
      <h1>Log in with a code</h1>
      <input value={email} onChange={(e) => setEmail(e.target.value)} />
      <button onClick={() => postJson<{ devCode: string }>('/api/magic', { email }).then((r) => setSent(r.devCode))}>Send me a code</button>
      {sent && (
        <>
          <p className="muted">Sent (dev: {sent}).</p>
          <input value={code} onChange={(e) => setCode(e.target.value)} />
          <button onClick={() => loginWithCode(email, code).then(() => navigate('/'))}>Log in</button>
        </>
      )}
    </main>
  )
}

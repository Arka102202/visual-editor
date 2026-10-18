// A10: deleting the account needs a recent second factor.
import { useState } from 'react'
import { request } from '@/api/http'
import { useAuth } from '@/auth/AuthContext'
import { TwoFactorDialog } from '@/components/TwoFactorDialog'

export function Account() {
  const { user } = useAuth()
  const [asking, setAsking] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const remove = () =>
    request<{ deleted: boolean }>('/api/account', { method: 'DELETE' }).then(
      () => setMessage('Account deleted'),
      (e: Error) => (/Second factor/.test(e.message) ? setAsking(true) : setMessage(e.message)),
    )
  return (
    <main>
      <h1>Your account</h1>
      <p>{user?.email}</p>
      <button onClick={remove}>Delete my account</button>
      <TwoFactorDialog open={asking} onCancel={() => setAsking(false)} onPassed={() => (setAsking(false), remove())} />
      {message && <p>{message}</p>}
    </main>
  )
}

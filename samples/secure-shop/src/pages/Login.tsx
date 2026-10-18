// The login page: any email works (admin@… is an admin, …pro… has the Pro plan). Needs the CAPTCHA (C21).
import { useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '@/auth/AuthContext'
import { Captcha } from '@/components/Captcha'

export function Login() {
  const { login } = useAuth()
  const navigate = useNavigate()
  const from = (useLocation().state as { from?: string } | null)?.from ?? '/'
  const [email, setEmail] = useState('admin.pro@example.com')
  const [captcha, setCaptcha] = useState('')
  const [error, setError] = useState<string | null>(null)
  return (
    <main>
      <h1>Log in</h1>
      <p className="muted">Any password. admin@… is an admin; an email with "pro" has the Pro plan.</p>
      <input value={email} onChange={(e) => setEmail(e.target.value)} />
      <Captcha onSolved={setCaptcha} />
      <button disabled={!captcha} onClick={() => login(email, captcha).then(() => navigate(from), (e: Error) => setError(e.message))}>
        Log in
      </button>
      {error && <p className="error">{error}</p>}
      <p>
        <Link to="/login/code">Log in with a one-time code</Link> · <Link to="/profile">Log in with Auth0</Link>
      </p>
    </main>
  )
}

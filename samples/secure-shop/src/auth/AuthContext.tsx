// B13: who is logged in, for the whole app: an AuthProvider and the useAuth() hook.
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { postJson, tokens, whenLoggedOut } from '@/api/http'
import type { User } from '@/types'

export interface AuthState {
  user: User | null
  /** Still asking the backend who this is (on first load). */
  checking: boolean
  login: (email: string, captcha: string) => Promise<void>
  loginWithCode: (email: string, code: string) => Promise<void>
  logout: () => Promise<void>
}

const AuthContext = createContext<AuthState | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [checking, setChecking] = useState(true)

  useEffect(() => {
    // A1: the session cookie says who this is.
    fetch('/api/me', { credentials: 'include' })
      .then((r) => (r.ok ? (r.json() as Promise<User>) : null))
      .then(setUser)
      .finally(() => setChecking(false))
    whenLoggedOut(() => setUser(null))
  }, [])

  const signedIn = ({ user, accessToken }: { user: User; accessToken: string }) => {
    tokens.set(accessToken)
    setUser(user)
  }
  const value: AuthState = {
    user,
    checking,
    login: async (email, captcha) => signedIn(await postJson('/api/login', { email, password: 'anything', captcha })),
    loginWithCode: async (email, code) => signedIn(await postJson('/api/magic/verify', { email, code })),
    logout: async () => {
      await postJson('/api/logout')
      tokens.clear()
      setUser(null)
    },
  }
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthState {
  const auth = useContext(AuthContext)
  if (!auth) throw new Error('useAuth must be used inside <AuthProvider>')
  return auth
}

// A7: a login provider (Auth0). The page only shows when Auth0 says the person is logged in.
import { useAuth0 } from '@auth0/auth0-react'

export function Profile() {
  const { isAuthenticated, isLoading, user, loginWithRedirect, logout } = useAuth0()
  if (isLoading) return <main><p>Checking Auth0…</p></main>
  if (!isAuthenticated) {
    void loginWithRedirect()
    return <main><p>Sending you to Auth0…</p></main>
  }
  return (
    <main>
      <h1>{user?.name}</h1>
      <p className="muted">{user?.email} (from Auth0)</p>
      <button onClick={() => logout()}>Log out of Auth0</button>
    </main>
  )
}

// The links each person sees depend on who they are: admin pages for admins (B14), a Pro badge (B15).
import { Link } from 'react-router-dom'
import { useAuth } from '@/auth/AuthContext'

export function Navbar() {
  const { user, logout } = useAuth()
  return (
    <nav>
      <b>Secure Shop</b>
      <Link to="/">Home</Link>
      <Link to="/orders">Orders</Link>
      <Link to="/catalog">Catalog</Link>
      {user?.role === 'admin' && <Link to="/admin">Admin</Link>}
      {user?.plan === 'pro' ? <Link to="/reports">Reports</Link> : <span className="muted">Reports (Pro)</span>}
      <span className="spacer" />
      {user ? (
        <>
          <span>
            {user.name} {user.plan === 'pro' && <span className="badge">PRO</span>}
          </span>
          <button onClick={logout}>Log out</button>
        </>
      ) : (
        <Link to="/login">Log in</Link>
      )}
    </nav>
  )
}

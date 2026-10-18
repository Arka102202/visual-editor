// A1 + A2: the home page greets the person from the session, and shows notifications read with the JWT cookie.
import { useQuery } from '@tanstack/react-query'
import { getJson } from '@/api/http'
import { useAuth } from '@/auth/AuthContext'
import type { Notification } from '@/types'

export function Home() {
  const { user } = useAuth()
  const { data: notes } = useQuery<Notification[]>({ queryKey: ['notifications'], queryFn: () => getJson<Notification[]>('/api/notifications'), enabled: !!user })
  if (!user) return <main><h1>Welcome</h1><p>Please log in to see your orders.</p></main>
  return (
    <main>
      <h1>Hello, {user.name}</h1>
      <p className="muted">{user.email} · {user.role} · {user.plan} plan</p>
      <h2>Notifications</h2>
      {notes?.map((n) => <div className="card" key={n.id}>{n.text} <span className="muted">{new Date(n.at).toLocaleTimeString()}</span></div>)}
    </main>
  )
}

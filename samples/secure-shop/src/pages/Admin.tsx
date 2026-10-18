// B14 (inside the page): admins only. Others are sent home, even if they type the address.
import { useQuery } from '@tanstack/react-query'
import { Navigate } from 'react-router-dom'
import { getJson } from '@/api/http'
import { useAuth } from '@/auth/AuthContext'
import type { AdminStats } from '@/types'

export function Admin() {
  const { user } = useAuth()
  const { data } = useQuery<AdminStats>({ queryKey: ['admin-stats'], queryFn: () => getJson<AdminStats>('/api/admin/stats'), enabled: user?.role === 'admin' })
  if (!user || user.role !== 'admin') return <Navigate to="/" replace />
  if (!data) return <main><p>Loading…</p></main>
  return (
    <main>
      <h1>Admin</h1>
      <div className="card">{data.users} users · ${data.revenue.toFixed(2)} revenue · {data.refunds} refunds</div>
      <p className="muted">Top product: {data.topProduct.name}</p>
    </main>
  )
}

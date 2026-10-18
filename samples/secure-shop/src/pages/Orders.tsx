// A3 + A4 + C20: orders need the access token; when it expires the request renews it and retries.
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { getJson } from '@/api/http'
import { OrderCard } from '@/components/OrderCard'
import type { Order, Page } from '@/types'

export function Orders() {
  const navigate = useNavigate()
  const { data, isLoading, error } = useQuery<Page<Order>>({ queryKey: ['orders'], queryFn: () => getJson<Page<Order>>('/api/orders') })
  if (isLoading) return <main><p>Loading orders…</p></main>
  if (error) return <main><p className="error">Could not load orders: {error.message}</p></main>
  return (
    <main>
      <h1>{data!.total} orders</h1>
      {data!.items.map((o) => <OrderCard key={o.id} order={o} onOpen={(id) => navigate(`/orders/${id}`)} />)}
    </main>
  )
}

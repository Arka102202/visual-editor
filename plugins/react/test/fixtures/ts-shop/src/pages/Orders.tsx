import { useQuery } from '@tanstack/react-query'
import { getJson } from '@/api'
import type { Order, Page } from '@/types'
import { OrderCard } from '@/components/OrderCard'
export function Orders() {
  const { data } = useQuery<Page<Order>>({ queryKey: ['orders'], queryFn: () => getJson<Page<Order>>('/api/orders') })
  if (!data) return null
  return <main>{data.items.map((o) => <OrderCard key={o.id} order={o} onOpen={() => {}} />)}</main>
}

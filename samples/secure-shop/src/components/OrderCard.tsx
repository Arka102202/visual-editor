import type { Order } from '@/types'

interface Props {
  order: Order
  onOpen: (id: string) => void
}

export function OrderCard({ order, onOpen }: Props) {
  return (
    <div className="card" onClick={() => onOpen(order.id)}>
      <b>{order.id}</b> · {order.customer.name} · <span className="badge">{order.status}</span>
      <div className="muted">
        {order.items.length} items · ${order.total.toFixed(2)} · {new Date(order.placedAt).toLocaleDateString()}
      </div>
    </div>
  )
}

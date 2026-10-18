// C17: cancelling an order is a change, so it carries the CSRF token (and the session cookie).
import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { getJson, postJson } from '@/api/http'
import type { Order } from '@/types'

export function OrderDetail() {
  const { orderId } = useParams()
  const [order, setOrder] = useState<Order | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  useEffect(() => {
    getJson<Order>(`/api/orders/${orderId}`).then(setOrder)
  }, [orderId])
  if (!order) return <main><p>Loading…</p></main>
  return (
    <main>
      <h1>Order {order.id}</h1>
      <p className="muted">{order.customer.name} · {order.customer.email} · {order.status}</p>
      {order.items.map((i) => <div className="card" key={i.sku}>{i.name} × {i.quantity} — ${i.price.toFixed(2)}</div>)}
      <button onClick={() => postJson<{ status: string }>(`/api/orders/${order.id}/cancel`).then((r) => setMessage(`Now ${r.status}`), (e: Error) => setMessage(e.message))}>Cancel order</button>
      {message && <p>{message}</p>}
    </main>
  )
}

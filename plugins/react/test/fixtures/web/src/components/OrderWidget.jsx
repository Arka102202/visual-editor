import { useEffect, useState } from 'react'

export function OrderWidget() {
  const [orders, setOrders] = useState([])
  useEffect(() => {
    fetch('/api/orders').then((r) => r.json()).then(setOrders)
  }, [])
  return <ul>{orders.slice(0, 3).map((o) => <li key={o.id}>{o.id}</li>)}</ul>
}

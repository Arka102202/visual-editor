import { useEffect, useState } from 'react'
import { ordersUrl } from '../config'
import { OrderWidget } from '../components/OrderWidget'
import { Profile } from '../components/Profile'
import { StatusBadge } from '../components/StatusBadge'

// Loads the orders, and so does OrderWidget inside it (loaded twice).
export default function Dashboard() {
  const [orders, setOrders] = useState([])
  const [isLoading, setLoading] = useState(true)
  const load = async () => {
    const res = await fetch(ordersUrl())
    setOrders(await res.json())
    setLoading(false)
  }
  useEffect(() => { load() }, [])
  if (isLoading) return <p>Loading…</p>
  return (
    <div>
      <h1>{orders.length} orders</h1>
      <OrderWidget />
      <Profile />
      <StatusBadge />
    </div>
  )
}

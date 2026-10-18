import React from 'react'
import { api } from '../api/client'
import Card from '@/components/Card'

// Loads data but never shows loading or error states.
export default function Orders() {
  const [orders, setOrders] = React.useState([])
  React.useEffect(() => { api.getOrders().then(setOrders) }, [])
  return <div>{orders.map((o) => <Card key={o.id} title={o.id} onOpen={() => api.cancelOrder(o.id)} />)}</div>
}

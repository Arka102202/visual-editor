import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { getJson } from '@/api'
import type { Order } from '@/types'
export function OrderDetail() {
  const { id } = useParams()
  const [order, setOrder] = useState<Order | null>(null)
  useEffect(() => { getJson<Order>(`/api/orders/${id}`).then(setOrder) }, [id])
  if (!order) return null
  return <h1>{order.id}</h1>
}

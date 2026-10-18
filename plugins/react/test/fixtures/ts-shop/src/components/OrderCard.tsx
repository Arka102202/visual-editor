import type { Order } from '@/types'
interface Props { order: Order; onOpen: (id: string) => void; compact?: boolean; tone?: 'calm' | 'loud' }
export function OrderCard({ order, onOpen, compact }: Props) {
  return <div onClick={() => onOpen(order.id)}>{order.customer.name}{compact ? '' : order.status}</div>
}

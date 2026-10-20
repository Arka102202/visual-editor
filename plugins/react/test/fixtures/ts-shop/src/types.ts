export type OrderStatus = 'new' | 'paid' | 'shipped' | 'cancelled'
export enum Role { Admin = 'admin', Staff = 'staff', Customer = 'customer' }
export interface Customer { id: string; name: string; email: string; role: Role }
export interface OrderItem { sku: string; name: string; quantity: number; price: number }
export interface Order {
  id: string
  status: OrderStatus
  customer: Customer
  items: OrderItem[]
  total: number
  placedAt: Date
  note?: string | null
}
export interface Page<T> { items: T[]; total: number; nextCursor: string | null }

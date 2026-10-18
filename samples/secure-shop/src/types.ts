export type Role = 'admin' | 'staff' | 'customer'
export type Plan = 'free' | 'pro'
export type OrderStatus = 'new' | 'paid' | 'shipped' | 'cancelled'

export interface User {
  id: string
  name: string
  email: string
  role: Role
  plan: Plan
}

export interface OrderItem { sku: string; name: string; quantity: number; price: number }
export interface Order {
  id: string
  status: OrderStatus
  total: number
  placedAt: string
  items: OrderItem[]
  customer: Pick<User, 'id' | 'name' | 'email' | 'role'>
}
export interface Page<T> { items: T[]; total: number; nextCursor: string | null }

export interface Notification { id: string; text: string; read: boolean; at: string }
export interface AdminStats { users: number; revenue: number; refunds: number; topProduct: { sku: string; name: string } }
export interface Report { id: string; title: string; rows: number; createdAt: string }
export interface Product { sku: string; name: string; price: number; stock: number }
export interface Health { status: 'ok' | 'degraded'; uptimeSeconds: number }
export interface SignedLink { url: string; expiresAt: string }

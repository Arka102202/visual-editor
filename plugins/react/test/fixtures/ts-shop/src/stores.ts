import { create } from 'zustand'
import { configureStore } from '@reduxjs/toolkit'
import { atom } from 'jotai'
import { proxy } from 'valtio'
import type { Customer, Order } from './types'

interface CartState {
  items: { sku: string; name: string; quantity: number; price: number }[]
  theme: 'light' | 'dark'
  add(sku: string): void
}
export const useCartStore = create<CartState>()((set) => ({ items: [], theme: 'dark', add: () => set({}) }))

interface AuthState { user: Customer | null; isAuthenticated: boolean }
const auth = (state: AuthState = { user: null, isAuthenticated: false }, _action: unknown): AuthState => state
export const store = configureStore({ reducer: { auth } })

export const selectedOrderAtom = atom<Order | null>(null)
// Worked out from others: nothing to fill.
export const countAtom = atom((get: unknown) => 1)

export const ui = proxy({ sidebarOpen: false, recent: [] as string[] })

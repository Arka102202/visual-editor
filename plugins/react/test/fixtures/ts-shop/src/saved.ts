import { useState } from 'react'
import type { OrderItem } from './types'

const CART_KEY = 'shop.cart'

export function loadCart(): OrderItem[] {
  return JSON.parse(localStorage.getItem(CART_KEY) ?? '[]')
}

export function useRecent() {
  const [recent] = useState<string[]>(() => JSON.parse(sessionStorage.getItem('recent-searches') || '[]'))
  const prefs = JSON.parse(localStorage.getItem('prefs') ?? '{}') as { compact: boolean; currency: 'EUR' | 'USD' }
  const token = JSON.parse(localStorage.getItem('auth') ?? 'null') as { token: string }
  return { recent, prefs, token }
}

export function Untyped() {
  useState(() => {
    // Read inside an effect-like callback whose value isn't kept: no type to go by.
    console.log(JSON.parse(localStorage.getItem('debug') ?? '{}'))
  })
}

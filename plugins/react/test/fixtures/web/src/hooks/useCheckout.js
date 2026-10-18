import { useEffect } from 'react'

// A hook that returns functions for components to call from buttons.
export function useCheckout() {
  const submit = async (cart) => {
    await fetch('/api/orders', { method: 'POST', body: JSON.stringify(cart) })
  }
  const openPayment = async () => fetch('/api/checkout/session', { method: 'POST' })

  // Only handed to the browser inside an effect (runs later, when the user comes back online),
  // and run from a button: this is "on action", not "on load".
  const resume = async () => fetch('/api/checkout/resume', { method: 'POST' })
  useEffect(() => {
    window.addEventListener('online', resume)
    return () => window.removeEventListener('online', resume)
  }, [])
  const handleResume = () => resume()

  return { submit, openPayment, handleResume }
}

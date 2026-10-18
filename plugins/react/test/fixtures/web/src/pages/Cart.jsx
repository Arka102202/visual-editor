import { useCartStore } from '../store'
import { PrimaryBtn } from '../components/Buttons'
import { useCheckout } from '../hooks/useCheckout'

export const Cart = () => {
  const items = useCartStore((s) => s.items)
  const { submit, openPayment } = useCheckout()
  if (items.length === 0) return <p>Your cart is empty</p>
  return <div>{items.map((i) => <p key={i.id}>{i.name}</p>)}<PrimaryBtn label="Checkout" onClick={() => submit(items)} /><PrimaryBtn label="Pay" onClick={openPayment} /></div>
}

import { useParams } from 'react-router-dom'
import { useProduct } from '@/hooks/useProduct'
import { Modal } from '@/components/Modal'
import { SubmitButton } from '@/components/Buttons'
import { useCartStore } from '@/store'

export function ProductPage() {
  const { id } = useParams()
  const { product, isLoading, error } = useProduct(id)
  const add = useCartStore((s) => s.add)
  if (isLoading) return <div>Loading…</div>
  if (error) return <div className="error">{error.message}</div>
  return (
    <div>
      <h1>{product.name}</h1>
      <SubmitButton label="Add to cart" onClick={() => add(product)} />
      <Modal title="Details" onClose={() => {}} open={false} />
    </div>
  )
}

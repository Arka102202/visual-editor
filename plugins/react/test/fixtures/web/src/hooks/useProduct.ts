import { useEffect, useState } from 'react'
import axios from 'axios'

export function useProduct(id?: string) {
  const [product, setProduct] = useState<any>(null)
  const [isLoading, setLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)
  useEffect(() => {
    axios.get('/api/products/' + id).then((r) => setProduct(r.data)).catch(setError).finally(() => setLoading(false))
  }, [id])
  return { product, isLoading, error }
}

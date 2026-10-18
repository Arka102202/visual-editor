// A5: the catalog API needs an API key (from the app's environment).
import { useEffect, useState } from 'react'
import type { Product } from '@/types'

export function Catalog() {
  const [products, setProducts] = useState<Product[]>([])
  useEffect(() => {
    fetch('/api/catalog', { headers: { 'X-API-Key': import.meta.env.VITE_CATALOG_KEY } })
      .then((r) => r.json() as Promise<Product[]>)
      .then(setProducts)
  }, [])
  return (
    <main>
      <h1>Catalog</h1>
      {products.map((p) => <div className="card" key={p.sku}>{p.name} · ${p.price.toFixed(2)} · {p.stock} in stock</div>)}
    </main>
  )
}

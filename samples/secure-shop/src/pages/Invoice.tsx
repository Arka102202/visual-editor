// C22: an expiring, signed download link.
import { useState } from 'react'
import { getJson } from '@/api/http'
import type { SignedLink } from '@/types'

export function Invoice() {
  const [link, setLink] = useState<SignedLink | null>(null)
  return (
    <main>
      <h1>Invoices</h1>
      <button onClick={() => getJson<SignedLink>('/api/invoices/A-1001/link').then(setLink)}>Get download link</button>
      {link && <p><a href={link.url}>Download A-1001</a> <span className="muted">expires {new Date(link.expiresAt).toLocaleTimeString()}</span></p>}
    </main>
  )
}

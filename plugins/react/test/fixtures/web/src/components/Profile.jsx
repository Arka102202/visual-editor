import { useEffect, useState } from 'react'
import { http } from '../api/http'

export function Profile() {
  const [me, setMe] = useState(null)
  const [error, setError] = useState(null)
  useEffect(() => {
    http.get('/me').then((r) => setMe(r.data)).catch(setError)
  }, [])
  const handleRefresh = () => http.get('/me').then((r) => setMe(r.data))
  if (error) return <p>Could not load your profile</p>
  return (
    <div>
      <p>{me?.name}</p>
      <button onClick={handleRefresh}>Refresh</button>
      <form onSubmit={(e) => http.post('/me/avatar', new FormData(e.target))}>
        <input type="file" name="avatar" />
      </form>
    </div>
  )
}

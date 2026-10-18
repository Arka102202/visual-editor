// B15: Pro plan only (the plan from the user, the beta flag from the features store).
import { useQuery } from '@tanstack/react-query'
import { getJson } from '@/api/http'
import { useAuth } from '@/auth/AuthContext'
import { useFeatures } from '@/store/features'
import type { Report } from '@/types'

export function Reports() {
  const { user } = useAuth()
  const betaCharts = useFeatures((s) => s.betaCharts)
  const pro = user?.plan === 'pro'
  const { data } = useQuery<Report[]>({ queryKey: ['reports'], queryFn: () => getJson<Report[]>('/api/reports'), enabled: pro })
  if (!pro) return <main><h1>Reports</h1><p>Reports come with the Pro plan.</p><button>Upgrade</button></main>
  return (
    <main>
      <h1>Reports</h1>
      {betaCharts && <p className="badge">Beta charts are on</p>}
      {data?.map((r) => <div className="card" key={r.id}>{r.title} · {r.rows} rows</div>)}
    </main>
  )
}

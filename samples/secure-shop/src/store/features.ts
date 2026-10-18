// B15: feature flags (a zustand store), switched on by the plan and by beta opt-in.
import { create } from 'zustand'
import type { Plan } from '@/types'

interface Features {
  plan: Plan
  betaCharts: boolean
  setPlan: (plan: Plan) => void
  toggleBeta: () => void
}

export const useFeatures = create<Features>((set) => ({
  plan: 'free',
  betaCharts: false,
  setPlan: (plan) => set({ plan }),
  toggleBeta: () => set((s) => ({ betaCharts: !s.betaCharts })),
}))

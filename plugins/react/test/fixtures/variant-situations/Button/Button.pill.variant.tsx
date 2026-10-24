import type { ButtonView } from './Button.types'

export const variant = { id: 'pill', name: 'Pill', for: ['primary', 'secondary'] }

/** Fully round, soft: for everyday actions (not made for danger). */
export default function ButtonPill({ kind, label, onClick, disabled }: ButtonView) {
  return (
    <button onClick={onClick} disabled={disabled} className={`px-5 py-1.5 rounded-full text-[13px] font-medium cursor-pointer disabled:opacity-40 ${kind === 'primary' ? 'bg-accent text-accent-text' : 'bg-surface text-text border border-border'}`}>
      {label}
    </button>
  )
}

import type { ButtonView } from './Button.types'

export const variant = { id: 'sharp', name: 'Sharp' }

const look = {
  primary:   'bg-accent text-accent-text',
  secondary: 'bg-surface-raised text-text',
  danger:    'bg-danger text-white',
}

/** Square corners and capitals: louder, for actions that can't be undone. */
export default function ButtonSharp({ kind, label, onClick, disabled }: ButtonView) {
  return (
    <button onClick={onClick} disabled={disabled} className={`px-4 py-2 rounded-none text-[11px] font-bold uppercase tracking-wider cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${look[kind]}`}>
      {label}
    </button>
  )
}

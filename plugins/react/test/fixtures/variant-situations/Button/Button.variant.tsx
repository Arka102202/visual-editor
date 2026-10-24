import type { ButtonView } from './Button.types'

export const variant = { id: 'rounded', name: 'Rounded' }

const look = {
  primary:   'bg-accent text-accent-text border-transparent',
  secondary: 'bg-transparent text-text border-border-strong',
  danger:    'bg-transparent text-danger border-danger',
}

/** Rounded corners, a solid fill for the main action. */
export default function ButtonRounded({ kind, label, onClick, disabled }: ButtonView) {
  return (
    <button onClick={onClick} disabled={disabled} className={`px-3.5 py-1.5 rounded-md border text-[13px] font-semibold cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${look[kind]}`}>
      {label}
    </button>
  )
}

import type { ButtonStart } from './Button.types'

const base: ButtonStart = { kind: 'primary', label: 'Save', onClick: () => {} }

/** The starting data: each state shows one situation. */
export const states: Record<string, ButtonStart> = {
  primary:           base,
  secondary:         { ...base, kind: 'secondary', label: 'Cancel' },
  danger:            { ...base, kind: 'danger', label: 'Delete project' },
  'danger disabled': { ...base, kind: 'danger', label: 'Delete project', disabled: true },
}

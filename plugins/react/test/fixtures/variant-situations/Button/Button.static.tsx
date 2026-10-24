import ButtonSwitcher from './Button.switcher'
import type { ButtonStart } from './Button.types'

/** The prototype: the same as the real part (a button keeps no data). */
export default function ButtonStatic({ kind, label, onClick, disabled = false }: ButtonStart) {
  return <ButtonSwitcher kind={kind} label={label} onClick={onClick} disabled={disabled} />
}

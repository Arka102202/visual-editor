import ButtonSwitcher from './Button.switcher'
import type { ButtonProps } from './Button.types'

/** The real part: a button has no data of its own, it shows what its parent passes. */
export default function ButtonData({ kind, label, onClick, disabled = false }: ButtonProps) {
  return <ButtonSwitcher kind={kind} label={label} onClick={onClick} disabled={disabled} />
}

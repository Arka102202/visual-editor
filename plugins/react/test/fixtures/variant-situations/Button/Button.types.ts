/** The situations a parent picks from: one design is in use for each. */
export type ButtonSituation = 'primary' | 'secondary' | 'danger'

/** What a parent passes. */
export interface ButtonProps {
  kind:      ButtonSituation
  label:     string
  onClick:   () => void
  disabled?: boolean
}

/** What the static part starts from: the same as what a parent passes. */
export type ButtonStart = ButtonProps

/** What every design gets. */
export interface ButtonView {
  kind:     ButtonSituation
  label:    string
  onClick:  () => void
  disabled: boolean
}

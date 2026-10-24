import { makeSwitcher } from '@visual-editor/react'
import Rounded from './Button.variant'
import Sharp from './Button.sharp.variant'

import type { ButtonSituation, ButtonView } from './Button.types'

// The design in use for each situation: change a line to use another.
export default makeSwitcher<ButtonView, ButtonSituation>({
  situation: 'kind',
  inUse: {
    primary: Rounded,
    secondary: Rounded,
    danger: Sharp,
  },
  // Every design, for Preview only (left out of production builds).
  every: import.meta.env.DEV ? () => [import('./Button.variant'), import('./Button.sharp.variant'), import('./Button.pill.variant')] : undefined,
})

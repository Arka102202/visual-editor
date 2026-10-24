import { makeSwitcher } from '@visual-editor/react'
// The design in use: change this line to use another.
import Selected, { variant } from './ProjectList.variant'

import type { ProjectListView } from './ProjectList.types'

export default makeSwitcher<ProjectListView>(
  Selected,
  variant,
  // Every design, for Preview only (left out of production builds).
  import.meta.env.DEV ? () => [import('./ProjectList.variant')] : undefined,
)

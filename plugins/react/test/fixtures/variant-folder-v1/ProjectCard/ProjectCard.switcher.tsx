import { makeSwitcher } from '../../../../visual-editor'
// The variant in use: change this line to use another.
import Selected, { variant } from './ProjectCard.variant'
import type { ProjectCardView } from './ProjectCard.types'

export default makeSwitcher<ProjectCardView>(
  Selected,
  variant,
  // Every variant, for Preview only (left out of production builds).
  import.meta.env.DEV ? () => [import('./ProjectCard.variant'), import('./ProjectCard.compact.variant')] : undefined,
)

import { StaticPart, useVariantKey } from '../../../../visual-editor'
import ProjectCardData from './ProjectCard.data'
import type { ProjectCardProps } from './ProjectCard.types'

// The static part and its starting data: development only (left out of production builds).
const preview = import.meta.env.DEV ? { start: () => import('./ProjectCard.mock'), part: () => import('./ProjectCard.static') } : undefined

/** The chooser: the dynamic part in the app; the static prototype in Preview and the Playground. */
export default function ProjectCard(props: ProjectCardProps) {
  if (useVariantKey() === 'real' || !preview) return <ProjectCardData {...props} />
  return <StaticPart {...preview} props={props} />
}

export { ProjectCard }
export type { ProjectCardProps, ProjectCardView } from './ProjectCard.types'

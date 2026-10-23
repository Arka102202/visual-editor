import { MockData, useVariantKey } from '../../../../visual-editor'
import ProjectCardData from './ProjectCard.data'
import ProjectCardSwitcher from './ProjectCard.switcher'
import type { ProjectCardProps, ProjectCardView } from './ProjectCard.types'

// Fixed data, for Preview only (left out of production builds).
const mock = import.meta.env.DEV ? () => import('./ProjectCard.mock') : undefined

/** The chooser: real data in the app, fixed data in Preview. */
export default function ProjectCard(props: ProjectCardProps) {
  const key = useVariantKey()
  if (key === 'real' || !mock) return <ProjectCardData {...props} />
  return (
    <MockData<ProjectCardProps, ProjectCardView>
      load={mock}
      props={props}
      render={(view) => <ProjectCardSwitcher {...view} mode={key} />}
    />
  )
}

export { ProjectCard }
export type { ProjectCardProps, ProjectCardView } from './ProjectCard.types'

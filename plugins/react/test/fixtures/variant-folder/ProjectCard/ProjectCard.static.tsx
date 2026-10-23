import ProjectCardSwitcher from './ProjectCard.switcher'
import { timeAgo } from './ProjectCard.data'
import type { ProjectCardStart } from './ProjectCard.types'

/** The prototype: shapes the project it's given (from the page, or from its own starting data). */
export default function ProjectCardStatic({ project, accentColor, onOpen, onDelete }: ProjectCardStart) {
  return (
    <ProjectCardSwitcher
      name={project.name}
      description={project.description}
      updated={timeAgo(project.updatedAt)}
      accentColor={accentColor}
      onOpen={onOpen}
      onDelete={onDelete}
    />
  )
}

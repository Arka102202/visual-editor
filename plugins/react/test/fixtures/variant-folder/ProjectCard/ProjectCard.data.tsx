import ProjectCardSwitcher from './ProjectCard.switcher'
import type { ProjectCardProps } from './ProjectCard.types'

export const timeAgo = (ts: number): string => {
  const diff = Date.now() - ts
  const mins  = Math.floor(diff / 60_000)
  const hours = Math.floor(diff / 3_600_000)
  const days  = Math.floor(diff / 86_400_000)
  if (mins < 1)  return 'just now'
  if (hours < 1) return `${mins}m ago`
  if (days < 1)  return `${hours}h ago`
  return `${days}d ago`
}

/** The real data: the project as the app has it, ready to show. */
export default function ProjectCardData({ project, accentColor, onOpen, onDelete }: ProjectCardProps) {
  return (
    <ProjectCardSwitcher
      mode="real"
      name={project.name}
      description={project.description}
      updated={timeAgo(project.updatedAt)}
      accentColor={accentColor}
      onOpen={onOpen}
      onDelete={onDelete}
    />
  )
}

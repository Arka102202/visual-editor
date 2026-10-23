import type { Project } from '@entity'

/** What a parent passes to ProjectCard. */
export interface ProjectCardProps {
  project:     Project
  accentColor: string
  onOpen:      () => void
  onDelete:    () => void
}

/** What every variant gets: the data, ready to show. */
export interface ProjectCardView {
  name:        string
  description: string
  /** "just now", "5m ago", "2d ago" */
  updated:     string
  accentColor: string
  onOpen:      () => void
  onDelete:    () => void
}

/** What the static part starts from: the same as what a parent passes. */
export type ProjectCardStart = ProjectCardProps

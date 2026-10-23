import type { Project } from '@entity'
import type { CreateProjectInput } from './types'

/** What a parent passes: nothing (it's a page). */
export type ProjectListProps = Record<string, never>

/** What the static part starts from. */
export interface ProjectListStart {
  projects: Project[]
  /** Show the page while its projects load. */
  loading?: boolean
}

/** What every design gets: the data, ready to show, and what each click does. */
export interface ProjectListView {
  projects:     Project[]
  isLoading:    boolean
  isModalOpen:  boolean
  onNew:        () => void
  onCloseModal: () => void
  onCreate:     (input: CreateProjectInput) => Promise<void> | void
  onOpen:       (id: string) => void
  onDelete:     (id: string, name: string) => Promise<void> | void
}

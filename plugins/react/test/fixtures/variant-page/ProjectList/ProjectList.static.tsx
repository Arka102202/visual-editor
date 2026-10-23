import { useState } from 'react'
import { goTo } from '../../visual-editor'
import { toEditor } from '@constants/routes'
import ProjectListSwitcher from './ProjectList.switcher'
import type { ProjectListStart } from './ProjectList.types'

/** The prototype: the projects in memory. New adds one, Delete removes one, Open shows where it would go. */
export default function ProjectListStatic({ projects: start, loading = false }: ProjectListStart) {
  const [projects, setProjects] = useState(start)
  const [isModalOpen, setModalOpen] = useState(false)
  return (
    <ProjectListSwitcher
      projects={projects}
      isLoading={loading}
      isModalOpen={isModalOpen}
      onNew={() => setModalOpen(true)}
      onCloseModal={() => setModalOpen(false)}
      onCreate={(input) => {
        const now = Date.now()
        setProjects([{ id: crypto.randomUUID(), name: input.name.trim(), description: input.description.trim(), createdAt: now, updatedAt: now }, ...projects])
        setModalOpen(false)
      }}
      onOpen={(id) => goTo(toEditor(id))}
      onDelete={(id) => setProjects(projects.filter((p) => p.id !== id))}
    />
  )
}

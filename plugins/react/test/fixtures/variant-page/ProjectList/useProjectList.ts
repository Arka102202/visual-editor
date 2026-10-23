import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { db } from '@db'
import { toEditor } from '@constants/routes'
import { MESSAGES } from '@constants/messages'
import type { Project } from '@entity'
import type { CreateProjectInput } from './types'

interface ProjectListHook {
  projects:    Project[]
  isLoading:   boolean
  isModalOpen: boolean
  openModal:   () => void
  closeModal:  () => void
  openProject: (id: string) => void
  createProject: (input: CreateProjectInput) => Promise<void>
  deleteProject: (id: string, name: string) => Promise<void>
}

export const useProjectList = (): ProjectListHook => {
  const navigate = useNavigate()

  const [projects,    setProjects]    = useState<Project[]>([])
  const [isLoading,   setIsLoading]   = useState<boolean>(true)
  const [isModalOpen, setIsModalOpen] = useState<boolean>(false)

  const loadProjects = useCallback(async (): Promise<void> => {
    const rows = await db.projects.orderBy('updatedAt').reverse().toArray()
    setProjects(rows as Project[])
    setIsLoading(false)
  }, [])

  useEffect(() => {
    void loadProjects()
  }, [loadProjects])

  const openModal  = (): void => setIsModalOpen(true)
  const closeModal = (): void => setIsModalOpen(false)

  const openProject = (id: string): void => {
    navigate(toEditor(id))
  }

  const createProject = async (input: CreateProjectInput): Promise<void> => {
    const now = Date.now()
    const id  = crypto.randomUUID()
    await db.projects.add({
      id,
      name:        input.name.trim(),
      description: input.description.trim(),
      createdAt:   now,
      updatedAt:   now,
    })
    closeModal()
    navigate(toEditor(id))
  }

  const deleteProject = async (id: string, name: string): Promise<void> => {
    const confirmed = window.confirm(MESSAGES.project.deleteConfirm(name))
    if (!confirmed) return
    await db.projects.delete(id)
    await db.nodes.where('projectId').equals(id).delete()
    await db.edges.where('projectId').equals(id).delete()
    await loadProjects()
  }

  return {
    projects,
    isLoading,
    isModalOpen,
    openModal,
    closeModal,
    openProject,
    createProject,
    deleteProject,
  }
}

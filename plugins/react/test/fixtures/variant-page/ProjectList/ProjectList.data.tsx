import ProjectListSwitcher from './ProjectList.switcher'
import { useProjectList } from './useProjectList'

/** The real data: the projects from the database, and what each click really does. */
export default function ProjectListData() {
  const { projects, isLoading, isModalOpen, openModal, closeModal, openProject, createProject, deleteProject } = useProjectList()
  return (
    <ProjectListSwitcher
      projects={projects}
      isLoading={isLoading}
      isModalOpen={isModalOpen}
      onNew={openModal}
      onCloseModal={closeModal}
      onCreate={createProject}
      onOpen={openProject}
      onDelete={deleteProject}
    />
  )
}

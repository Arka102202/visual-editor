import { StaticPart, useVariantKey } from '../../visual-editor'
import ProjectListData from './ProjectList.data'

// The static part and its starting data: development only (left out of production builds).
const preview = import.meta.env.DEV ? { start: () => import('./ProjectList.mock'), part: () => import('./ProjectList.static') } : undefined

/** The chooser: the dynamic part in the app; the static prototype in Preview and the Playground. */
export default function ProjectList() {
  if (useVariantKey() === 'real' || !preview) return <ProjectListData />
  return <StaticPart {...preview} props={{}} />
}

export { ProjectList }
export type { CreateProjectInput } from './types'

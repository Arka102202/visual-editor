import { goTo } from '@visual-editor/react'
import type { ProjectCardStart } from './ProjectCard.types'

const ago = (minutes: number) => Date.now() - minutes * 60_000

const base: ProjectCardStart = {
  project:     { id: 'p1', name: 'order-service', description: 'Takes orders and sends them on.', createdAt: ago(600), updatedAt: ago(5) },
  accentColor: '#3860f5',
  onOpen:      () => goTo('/editor/p1'),
  onDelete:    () => {},
}

/** The starting data for Preview: one state per case worth seeing. */
export const states: Record<string, ProjectCardStart> = {
  default: base,
  'long name': {
    ...base,
    project: { ...base.project, name: 'customer-notification-and-preferences-service', description: 'Sends emails, texts and push notifications, and keeps what each customer wants to hear about.' },
  },
  'no description': { ...base, project: { ...base.project, description: '' } },
  'just created':   { ...base, project: { ...base.project, updatedAt: Date.now() }, accentColor: '#16a34a' },
}

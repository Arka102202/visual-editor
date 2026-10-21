import type { ProjectCardView } from './ProjectCard.types'

const base: ProjectCardView = {
  name:        'order-service',
  description: 'Takes orders and sends them on.',
  updated:     '5m ago',
  accentColor: '#3860f5',
  onOpen:      () => {},
  onDelete:    () => {},
}

/** Fixed data for Preview: one state per case worth seeing. */
export const states: Record<string, ProjectCardView> = {
  default: base,
  'long name': {
    ...base,
    name:        'customer-notification-and-preferences-service',
    description: 'Sends emails, texts and push notifications, and keeps what each customer wants to hear about.',
  },
  'no description': { ...base, description: '' },
  'just created':   { ...base, updated: 'just now', accentColor: '#16a34a' },
}

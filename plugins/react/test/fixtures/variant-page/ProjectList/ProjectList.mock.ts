import type { Project } from '@entity'
import type { ProjectListStart } from './ProjectList.types'

const ago = (minutes: number) => Date.now() - minutes * 60_000
const project = (id: string, name: string, description: string, minutes: number): Project => ({ id, name, description, createdAt: ago(minutes + 60), updatedAt: ago(minutes) })

const three: Project[] = [
  project('p1', 'order-service', 'Takes orders and sends them on.', 5),
  project('p2', 'payments', 'Charges cards and keeps receipts.', 90),
  project('p3', 'customer-notification-and-preferences-service', 'Sends emails, texts and push notifications.', 60 * 26),
]

/** The starting data for Preview: one state per case worth seeing. */
export const states: Record<string, ProjectListStart> = {
  default: { projects: three },
  empty: { projects: [] },
  many: { projects: Array.from({ length: 12 }, (_, i) => project(`m${i}`, `service-${i + 1}`, i % 3 ? 'Does one thing well.' : '', i * 37)) },
  loading: { projects: [], loading: true },
}

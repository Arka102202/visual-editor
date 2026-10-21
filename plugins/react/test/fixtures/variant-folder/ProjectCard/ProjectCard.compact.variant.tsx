import type { ProjectCardView } from './ProjectCard.types'

export const variant = { id: 'compact', name: 'Compact' }

/** A one-line card: the colour as a dot, the name, when it changed, and Delete on hover. */
export default function ProjectCardCompact({ name, updated, accentColor, onOpen, onDelete }: ProjectCardView) {
  return (
    <div
      onClick={onOpen}
      className="group w-[220px] flex items-center gap-2 px-3 py-2 bg-surface border border-border rounded-md cursor-pointer hover:border-border-strong"
    >
      <span className="w-2 h-2 rounded-full shrink-0" style={{ background: accentColor }} />
      <span className="flex-1 min-w-0 text-sm font-semibold text-text overflow-hidden text-ellipsis whitespace-nowrap">{name}</span>
      <span className="text-[10px] font-mono text-text-4 group-hover:hidden">{updated}</span>
      <button
        onClick={(e) => {
          e.stopPropagation()
          onDelete()
        }}
        className="hidden group-hover:block text-[11px] text-danger bg-transparent border-none cursor-pointer"
      >
        Delete
      </button>
    </div>
  )
}

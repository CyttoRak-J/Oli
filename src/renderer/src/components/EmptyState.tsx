import type { ReactNode } from 'react'

export function EmptyState({
  title,
  description,
  action,
  icon
}: {
  title: string
  description?: string
  action?: ReactNode
  icon?: ReactNode
}): React.JSX.Element {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-16 text-center">
      {icon && <div className="mb-1 text-ink-3">{icon}</div>}
      <div className="text-[15px] font-semibold text-ink-1">{title}</div>
      {description && (
        <div className="max-w-sm text-[13px] leading-relaxed text-ink-2">{description}</div>
      )}
      {action && <div className="mt-2">{action}</div>}
    </div>
  )
}
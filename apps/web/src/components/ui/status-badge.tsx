import { cn } from '@/lib/utils'
import type { EventStatus, ActionStatus } from '@/lib/api'

type AnyStatus = EventStatus | ActionStatus

const STATUS_STYLES: Record<string, string> = {
  open:         'bg-red-50 text-red-700 border-red-200',
  resolved:     'bg-green-50 text-green-700 border-green-200',
  suppressed:   'bg-gray-100 text-gray-600 border-gray-200',
  pending:      'bg-amber-50 text-amber-700 border-amber-200',
  approved:     'bg-green-50 text-green-700 border-green-200',
  rejected:     'bg-red-50 text-red-600 border-red-200',
  executed:     'bg-blue-50 text-blue-700 border-blue-200',
  not_executed: 'bg-gray-100 text-gray-500 border-gray-200',
}

const STATUS_LABELS: Record<string, string> = {
  open:         'Open',
  resolved:     'Resolved',
  suppressed:   'Suppressed',
  pending:      'Pending',
  approved:     'Approved',
  rejected:     'Rejected',
  executed:     'Executed',
  not_executed: 'Not Executed',
}

interface StatusBadgeProps {
  status: AnyStatus
  className?: string
}

export function StatusBadge({ status, className }: StatusBadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium',
        STATUS_STYLES[status] ?? 'bg-gray-100 text-gray-600 border-gray-200',
        className,
      )}
    >
      {STATUS_LABELS[status] ?? status}
    </span>
  )
}

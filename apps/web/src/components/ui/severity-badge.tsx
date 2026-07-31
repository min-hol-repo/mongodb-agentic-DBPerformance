import { cn } from '@/lib/utils'
import type { Severity } from '@/lib/api'

const SEVERITY_STYLES: Record<Severity, string> = {
  high:   'bg-red-100 text-red-700 border-red-200',
  medium: 'bg-amber-100 text-amber-700 border-amber-200',
  low:    'bg-blue-100 text-blue-700 border-blue-200',
}

const SEVERITY_DOTS: Record<Severity, string> = {
  high:   'bg-red-500',
  medium: 'bg-amber-500',
  low:    'bg-blue-500',
}

interface SeverityBadgeProps {
  severity: Severity
  className?: string
}

export function SeverityBadge({ severity, className }: SeverityBadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium',
        SEVERITY_STYLES[severity],
        className,
      )}
    >
      <span className={cn('h-1.5 w-1.5 rounded-full', SEVERITY_DOTS[severity])} />
      {severity.charAt(0).toUpperCase() + severity.slice(1)}
    </span>
  )
}

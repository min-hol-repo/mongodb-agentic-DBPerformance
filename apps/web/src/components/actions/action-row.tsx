import { StatusBadge } from '@/components/ui/status-badge'
import { ACTION_LABELS, MODE_LABELS, relativeTime } from '@/lib/api'
import type { ActuatorAction, ActuatorMode } from '@/lib/api'
import { cn } from '@/lib/utils'

interface ActionRowProps {
  action: ActuatorAction
  compact?: boolean
}

const MODE_STYLE: Record<ActuatorMode, string> = {
  dry_run:           'bg-slate-100 text-slate-600',
  approval_required: 'bg-amber-50 text-amber-700',
  auto_execute:      'bg-red-50 text-red-700',
}

export function ActionRow({ action, compact }: ActionRowProps) {
  return (
    <div className={cn('flex items-start gap-3 py-3 border-b last:border-0', compact && 'py-2')}>
      <StatusBadge status={action.result} className="mt-0.5 shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm font-medium text-foreground">
            {ACTION_LABELS[action.actionType] ?? action.actionType}
          </p>
          <span className="shrink-0 text-xs text-muted-foreground">
            {relativeTime(action.timestamp)}
          </span>
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <span
            className={cn(
              'rounded px-1.5 py-0.5 text-xs font-medium',
              MODE_STYLE[action.mode] ?? 'bg-gray-100 text-gray-600',
            )}
          >
            {MODE_LABELS[action.mode] ?? action.mode}
          </span>
          {action.ruleId && (
            <span className="font-mono text-xs text-muted-foreground">{action.ruleId}</span>
          )}
        </div>
        {!compact && action.beforeState && action.proposedState && (
          <p className="mt-1 text-xs text-muted-foreground">
            {JSON.stringify(action.beforeState)} → {JSON.stringify(action.proposedState)}
          </p>
        )}
        {!compact && action.cooldownUntil && (
          <p className="mt-1 text-xs text-amber-600">
            Cooldown until: {new Date(action.cooldownUntil).toLocaleTimeString('ko-KR')}
          </p>
        )}
      </div>
    </div>
  )
}

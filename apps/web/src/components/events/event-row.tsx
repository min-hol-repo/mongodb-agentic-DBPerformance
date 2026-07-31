import Link from 'next/link'
import { SeverityBadge } from '@/components/ui/severity-badge'
import { StatusBadge } from '@/components/ui/status-badge'
import { BOTTLENECK_LABELS, relativeTime } from '@/lib/api'
import type { BottleneckEvent } from '@/lib/api'

interface EventRowProps {
  event:       BottleneckEvent
  showCluster?: boolean
}

export function EventRow({ event, showCluster }: EventRowProps) {
  return (
    <div className="flex items-start gap-3 py-3 border-b last:border-0">
      <SeverityBadge severity={event.severity} className="mt-0.5 shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm font-medium text-foreground truncate">
            {BOTTLENECK_LABELS[event.type]}
          </p>
          <span className="shrink-0 text-xs text-muted-foreground">
            {relativeTime(event.timestamp)}
          </span>
        </div>
        <p className="mt-0.5 text-xs text-muted-foreground line-clamp-2">
          {event.summary}
        </p>
        <div className="mt-1.5 flex items-center gap-2 flex-wrap">
          <StatusBadge status={event.status} />
          {showCluster && (
            <Link
              href={`/clusters/${event.clusterName}`}
              className="text-xs text-blue-600 hover:underline"
            >
              {event.clusterName}
            </Link>
          )}
          <span className="text-xs font-mono text-muted-foreground">{event.ruleId}</span>
        </div>
        {event.recommendedActions.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1">
            {event.recommendedActions.slice(0, 3).map(a => (
              <span
                key={a}
                className="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-600"
              >
                {a.replace(/_/g, ' ')}
              </span>
            ))}
            {event.recommendedActions.length > 3 && (
              <span className="text-xs text-muted-foreground">
                +{event.recommendedActions.length - 3} more
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

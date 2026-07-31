import { SeverityBadge } from '@/components/ui/severity-badge'
import { StatusBadge } from '@/components/ui/status-badge'
import { BOTTLENECK_LABELS, relativeTime } from '@/lib/api'
import type { BottleneckEvent, BottleneckType } from '@/lib/api'
import { cn } from '@/lib/utils'

// ── 타입별 아이콘/색상 ────────────────────────────────────────────

const TYPE_STYLES: Record<BottleneckType, { dot: string; ring: string }> = {
  connection_pressure: { dot: 'bg-indigo-500', ring: 'ring-indigo-100' },
  cpu_saturation:      { dot: 'bg-amber-500',  ring: 'ring-amber-100' },
  storage_bottleneck:  { dot: 'bg-purple-500', ring: 'ring-purple-100' },
  query_inefficiency:  { dot: 'bg-red-500',    ring: 'ring-red-100' },
}

interface RuleHitTimelineProps {
  events: BottleneckEvent[]
}

export function RuleHitTimeline({ events }: RuleHitTimelineProps) {
  if (events.length === 0) {
    return (
      <div className="rounded-lg border border-dashed bg-white py-10 text-center">
        <p className="text-sm text-muted-foreground">No rule hits recorded yet.</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Events will appear after the detector runs and metrics exceed thresholds.
        </p>
      </div>
    )
  }

  return (
    <div className="rounded-lg border bg-white">
      <div className="divide-y">
        {events.map((event, idx) => {
          const typeStyle = TYPE_STYLES[event.type] ?? { dot: 'bg-gray-400', ring: 'ring-gray-100' }
          const isOpen = event.status === 'open'

          return (
            <div key={event._id} className="flex gap-4 px-4 py-3">
              {/* 타임라인 도트 */}
              <div className="flex flex-col items-center pt-1">
                <div
                  className={cn(
                    'h-3 w-3 rounded-full ring-2',
                    typeStyle.dot,
                    typeStyle.ring,
                    isOpen && 'animate-pulse',
                  )}
                />
                {idx < events.length - 1 && (
                  <div className="mt-1 w-px flex-1 bg-gray-200" />
                )}
              </div>

              {/* 이벤트 내용 */}
              <div className="min-w-0 flex-1 pb-3">
                {/* 첫 번째 행: 룰 타입 + 시각 + 상태 */}
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-semibold text-foreground">
                    {BOTTLENECK_LABELS[event.type] ?? event.type}
                  </span>
                  <SeverityBadge severity={event.severity} />
                  <StatusBadge status={event.status} />
                  <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                    {relativeTime(event.timestamp)}
                  </span>
                </div>

                {/* ruleId */}
                <p className="mt-0.5 font-mono text-xs text-muted-foreground">
                  {event.ruleId}
                </p>

                {/* 요약 */}
                <p className="mt-1 text-xs text-foreground/70 line-clamp-2">
                  {event.summary}
                </p>

                {/* 신호값 (signals) */}
                {event.signals && Object.keys(event.signals).length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
                    {Object.entries(event.signals)
                      .filter(([k]) => !k.toLowerCase().includes('threshold'))
                      .slice(0, 4)
                      .map(([key, value]) => (
                        <span key={key} className="text-xs text-muted-foreground">
                          <span className="font-medium text-foreground/80">
                            {key.replace(/([A-Z])/g, ' $1').replace(/^./, s => s.toUpperCase())}:
                          </span>{' '}
                          {typeof value === 'number' ? value.toFixed(value % 1 === 0 ? 0 : 1) : value}
                        </span>
                      ))}
                  </div>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

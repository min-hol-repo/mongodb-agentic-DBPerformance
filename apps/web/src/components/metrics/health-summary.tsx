import type { MetricsPoint, BottleneckEvent } from '@/lib/api'
import { cn } from '@/lib/utils'

// ── 임계치 정의 (룰과 동기화) ────────────────────────────────────
const THRESHOLDS = {
  connections:      { warning: 800,  critical: 1200, unit: '' },
  cpuNormalizedPct: { warning: 70,   critical: 90,   unit: '%' },
  diskQueueDepth:   { warning: 3.0,  critical: 6.0,  unit: '' },
  memoryUsedPct:    { warning: 80,   critical: 95,   unit: '%' },
  queryTargeting:   { warning: 100,  critical: 300,  unit: '' },
  readLatencyMs:    { warning: 20,   critical: 50,   unit: 'ms' },
}

type HealthStatus = 'ok' | 'warning' | 'critical'

interface HealthIndicator {
  label:     string
  value:     number
  unit:      string
  status:    HealthStatus
  threshold: { warning: number; critical: number }
  ruleId?:   string
  activeEvent?: BottleneckEvent
}

function getStatus(value: number, t: { warning: number; critical: number }): HealthStatus {
  if (value >= t.critical) return 'critical'
  if (value >= t.warning)  return 'warning'
  return 'ok'
}

const STATUS_STYLES: Record<HealthStatus, { bg: string; border: string; dot: string; text: string; label: string }> = {
  ok:       { bg: 'bg-green-50',  border: 'border-green-200', dot: 'bg-green-500',  text: 'text-green-700',  label: 'OK' },
  warning:  { bg: 'bg-amber-50',  border: 'border-amber-200', dot: 'bg-amber-500',  text: 'text-amber-700',  label: 'Warning' },
  critical: { bg: 'bg-red-50',    border: 'border-red-200',   dot: 'bg-red-500',    text: 'text-red-700',    label: 'Critical' },
}

interface HealthSummaryProps {
  latest?:      MetricsPoint
  openEvents:   BottleneckEvent[]
}

export function HealthSummary({ latest, openEvents }: HealthSummaryProps) {
  if (!latest) {
    return (
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {['Connections', 'CPU', 'Disk I/O', 'Query'].map(label => (
          <div key={label} className="rounded-lg border border-dashed bg-white p-4 text-center">
            <p className="text-xs text-muted-foreground">{label}</p>
            <p className="mt-1 text-sm text-muted-foreground">No data</p>
          </div>
        ))}
      </div>
    )
  }

  const m = latest.metrics

  const indicators: HealthIndicator[] = [
    {
      label:     'Connections',
      value:     m.connections,
      unit:      '',
      status:    getStatus(m.connections, THRESHOLDS.connections),
      threshold: THRESHOLDS.connections,
      ruleId:    'RULE_CONN_001',
      activeEvent: openEvents.find(e => e.type === 'connection_pressure'),
    },
    {
      label:     'CPU',
      value:     m.cpuNormalizedPct,
      unit:      '%',
      status:    getStatus(m.cpuNormalizedPct, THRESHOLDS.cpuNormalizedPct),
      threshold: THRESHOLDS.cpuNormalizedPct,
      ruleId:    'RULE_CPU_001',
      activeEvent: openEvents.find(e => e.type === 'cpu_saturation'),
    },
    {
      label:     'Disk Queue',
      value:     m.diskQueueDepth,
      unit:      '',
      status:    getStatus(m.diskQueueDepth, THRESHOLDS.diskQueueDepth) === 'ok'
                   ? getStatus(m.memoryUsedPct, THRESHOLDS.memoryUsedPct)
                   : getStatus(m.diskQueueDepth, THRESHOLDS.diskQueueDepth),
      threshold: THRESHOLDS.diskQueueDepth,
      ruleId:    'RULE_DISK_001',
      activeEvent: openEvents.find(e => e.type === 'storage_bottleneck'),
    },
    {
      label:     'Query Targeting',
      value:     m.queryTargeting,
      unit:      '',
      status:    getStatus(m.queryTargeting, THRESHOLDS.queryTargeting),
      threshold: THRESHOLDS.queryTargeting,
      ruleId:    'RULE_QUERY_001',
      activeEvent: openEvents.find(e => e.type === 'query_inefficiency'),
    },
  ]

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {indicators.map(ind => {
        const s = STATUS_STYLES[ind.status]
        const pct = Math.min(100, (ind.value / ind.threshold.critical) * 100)

        return (
          <div
            key={ind.label}
            className={cn('rounded-lg border p-4 transition-colors', s.bg, s.border)}
          >
            {/* 헤더 */}
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-medium text-muted-foreground">{ind.label}</span>
              <span className={cn('flex items-center gap-1 text-xs font-semibold', s.text)}>
                <span className={cn('h-1.5 w-1.5 rounded-full', s.dot)} />
                {s.label}
              </span>
            </div>

            {/* 값 */}
            <p className={cn('text-2xl font-bold tabular-nums', s.text)}>
              {ind.value % 1 === 0 ? ind.value : ind.value.toFixed(1)}
              <span className="ml-0.5 text-sm font-normal text-muted-foreground">{ind.unit}</span>
            </p>

            {/* 임계치 진행 바 */}
            <div className="mt-2 h-1 rounded-full bg-gray-200">
              <div
                className={cn('h-1 rounded-full transition-all', {
                  'bg-green-400': ind.status === 'ok',
                  'bg-amber-400': ind.status === 'warning',
                  'bg-red-500':   ind.status === 'critical',
                })}
                style={{ width: `${Math.min(pct, 100)}%` }}
              />
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              Warning ≥ {ind.threshold.warning}{ind.unit}
            </p>

            {/* 활성 이벤트 링크 */}
            {ind.activeEvent && (
              <p className="mt-1.5 text-xs font-medium text-red-600">
                ⚡ Active event
              </p>
            )}
          </div>
        )
      })}
    </div>
  )
}

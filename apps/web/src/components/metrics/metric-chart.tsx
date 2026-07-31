'use client'

import {
  LineChart, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, ReferenceLine,
} from 'recharts'
import { cn } from '@/lib/utils'
import type { MetricsPoint } from '@/lib/api'

// ── 단일 메트릭 미니 차트 ─────────────────────────────────────────

interface MetricChartProps {
  data:       MetricsPoint[]
  field:      keyof MetricsPoint['metrics']
  label:      string
  color?:     string
  unit?:      string
  threshold?: number
  height?:    number
}

export function MetricChart({
  data, field, label, color = '#3b82f6', unit = '', threshold, height = 90,
}: MetricChartProps) {
  const chartData = data.map(p => ({
    time:  new Date(p.timestamp).toLocaleTimeString('ko-KR', {
      hour: '2-digit', minute: '2-digit',
    }),
    value: p.metrics[field],
  }))

  const lastValue          = chartData.at(-1)?.value ?? 0
  const isAboveThreshold   = threshold !== undefined && lastValue > threshold
  const isInteger          = field === 'connections' || field === 'queryTargeting'

  return (
    <div
      className={cn(
        'rounded-lg border bg-white p-4 transition-colors',
        isAboveThreshold && 'border-red-200 bg-red-50',
      )}
    >
      {/* 헤더 */}
      <div className="mb-2 flex items-center justify-between">
        <span className="text-sm font-medium text-foreground">{label}</span>
        <span
          className={cn(
            'text-xl font-bold tabular-nums',
            isAboveThreshold ? 'text-red-600' : 'text-foreground',
          )}
        >
          {typeof lastValue === 'number'
            ? isInteger
              ? Math.round(lastValue)
              : lastValue.toFixed(1)
            : '—'}
          {unit && (
            <span className="ml-0.5 text-sm font-normal text-muted-foreground">{unit}</span>
          )}
        </span>
      </div>

      {/* 차트 */}
      <ResponsiveContainer width="100%" height={height}>
        <LineChart data={chartData} margin={{ top: 4, right: 4, left: -28, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false} />
          <XAxis
            dataKey="time"
            tick={{ fontSize: 9, fill: '#94a3b8' }}
            tickLine={false}
            axisLine={false}
            interval="preserveStartEnd"
          />
          <YAxis
            tick={{ fontSize: 9, fill: '#94a3b8' }}
            tickLine={false}
            axisLine={false}
            width={28}
          />
          <Tooltip
            contentStyle={{
              fontSize: 11,
              padding: '4px 8px',
              border: '1px solid #e2e8f0',
              borderRadius: '6px',
            }}
            formatter={(v: number) => [
              `${isInteger ? Math.round(v) : v.toFixed(1)}${unit}`,
              label,
            ]}
            labelStyle={{ color: '#64748b', fontSize: 10 }}
          />
          {threshold !== undefined && (
            <ReferenceLine
              y={threshold}
              stroke="#ef4444"
              strokeWidth={1}
              strokeDasharray="4 2"
              label={{ value: `⚠${threshold}`, position: 'right', fontSize: 8, fill: '#ef4444' }}
            />
          )}
          <Line
            type="monotone"
            dataKey="value"
            stroke={isAboveThreshold ? '#ef4444' : color}
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 3, strokeWidth: 0 }}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}

// ── 확대 차트 (문제 메트릭용) ─────────────────────────────────────

interface FocusChartProps {
  data:       MetricsPoint[]
  field:      keyof MetricsPoint['metrics']
  label:      string
  color?:     string
  unit?:      string
  threshold?: number
}

export function FocusChart({ data, field, label, color, unit, threshold }: FocusChartProps) {
  return (
    <MetricChart
      data={data}
      field={field}
      label={label}
      color={color}
      unit={unit}
      threshold={threshold}
      height={160}
    />
  )
}

// ── 8개 메트릭 그리드 ─────────────────────────────────────────────

interface MetricsGridProps {
  data: MetricsPoint[]
}

export function MetricsGrid({ data }: MetricsGridProps) {
  if (data.length === 0) {
    return (
      <div className="rounded-lg border border-dashed bg-white p-10 text-center">
        <p className="text-sm text-muted-foreground">
          No metric data available.
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          Start the collector worker and wait for the first collection cycle.
        </p>
      </div>
    )
  }

  // 임계치 초과 메트릭을 앞으로
  const latest = data.at(-1)?.metrics
  const hasCriticalConnections = latest && latest.connections >= 800
  const hasCriticalCpu         = latest && latest.cpuNormalizedPct >= 70
  const hasCriticalDisk        = latest && (latest.diskQueueDepth >= 3 || latest.memoryUsedPct >= 80)
  const hasCriticalQuery       = latest && latest.queryTargeting >= 100

  return (
    <div className="space-y-3">
      {/* 임계치 초과 시 해당 메트릭 확대 차트 */}
      {(hasCriticalConnections || hasCriticalCpu || hasCriticalDisk || hasCriticalQuery) && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {hasCriticalConnections && (
            <FocusChart data={data} field="connections"      label="Connections ⚠"     color="#6366f1" threshold={800} />
          )}
          {hasCriticalCpu && (
            <FocusChart data={data} field="cpuNormalizedPct" label="CPU % ⚠"           color="#f59e0b" unit="%" threshold={70} />
          )}
          {hasCriticalDisk && (
            <FocusChart data={data} field="diskQueueDepth"   label="Disk Queue ⚠"      color="#8b5cf6" threshold={3} />
          )}
          {hasCriticalQuery && (
            <FocusChart data={data} field="queryTargeting"   label="Query Targeting ⚠" color="#ef4444" threshold={100} />
          )}
        </div>
      )}

      {/* 전체 8개 메트릭 */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <MetricChart data={data} field="connections"      label="Connections"     color="#6366f1" threshold={800} />
        <MetricChart data={data} field="cpuNormalizedPct" label="CPU %"           color="#f59e0b" unit="%" threshold={70} />
        <MetricChart data={data} field="memoryUsedPct"    label="Memory %"        color="#10b981" unit="%" threshold={80} />
        <MetricChart data={data} field="diskQueueDepth"   label="Disk Queue"      color="#8b5cf6" threshold={3} />
        <MetricChart data={data} field="readLatencyMs"    label="Read Latency"    color="#3b82f6" unit="ms" threshold={20} />
        <MetricChart data={data} field="writeLatencyMs"   label="Write Latency"   color="#06b6d4" unit="ms" />
        <MetricChart data={data} field="diskUsedGb"       label="Disk Used"       color="#84cc16" unit=" GB" />
        <MetricChart data={data} field="queryTargeting"   label="Query Targeting" color="#ef4444" threshold={100} />
      </div>
    </div>
  )
}

import { Counter, Gauge, Histogram, collectDefaultMetrics } from 'prom-client'
import { startMetricsServer, startQueueDepthPoller } from '@demo/worker-utils'
import type { NormalizedMetrics } from '@demo/shared'

export { startMetricsServer, startQueueDepthPoller }

collectDefaultMetrics({ prefix: 'collector_process_' })

// ── 수집 run 메트릭 ───────────────────────────────────────────────

export const collectorRunTotal = new Counter({
  name: 'collector_run_total',
  help: 'Total number of collector runs attempted',
})

export const collectorRunFailuresTotal = new Counter({
  name: 'collector_run_failures_total',
  help: 'Total number of failed collector runs',
})

export const collectorRunDuration = new Histogram({
  name:    'collector_run_duration_seconds',
  help:    'Duration of each collector run in seconds',
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5],
})

export const collectorInsertedTotal = new Counter({
  name: 'collector_inserted_total',
  help: 'Total number of metric documents inserted into MongoDB',
})

// ── 큐 깊이 Gauge ─────────────────────────────────────────────────

export const collectorQueueDepth = new Gauge({
  name:       'collector_queue_depth',
  help:       'Number of jobs waiting or active in the collector BullMQ queue',
  labelNames: ['state'] as const,   // 'waiting' | 'active'
})

// ── Atlas 메트릭 값 Gauge (클러스터별) ───────────────────────────

export const atlasGauges = {
  connections: new Gauge({
    name: 'atlas_metric_connections', help: 'Current number of active client connections',
    labelNames: ['cluster'] as const,
  }),
  cpuNormalizedPct: new Gauge({
    name: 'atlas_metric_cpu_normalized_pct', help: 'Normalized CPU usage across all vCPUs (0-100)',
    labelNames: ['cluster'] as const,
  }),
  memoryUsedPct: new Gauge({
    name: 'atlas_metric_memory_used_pct', help: 'Memory usage as percentage of total (0-100)',
    labelNames: ['cluster'] as const,
  }),
  diskUsedGb: new Gauge({
    name: 'atlas_metric_disk_used_gb', help: 'Disk space used in gigabytes',
    labelNames: ['cluster'] as const,
  }),
  diskQueueDepth: new Gauge({
    name: 'atlas_metric_disk_queue_depth', help: 'Average disk I/O queue depth',
    labelNames: ['cluster'] as const,
  }),
  readLatencyMs: new Gauge({
    name: 'atlas_metric_read_latency_ms', help: 'Average read operation latency in milliseconds',
    labelNames: ['cluster'] as const,
  }),
  writeLatencyMs: new Gauge({
    name: 'atlas_metric_write_latency_ms', help: 'Average write operation latency in milliseconds',
    labelNames: ['cluster'] as const,
  }),
  queryTargeting: new Gauge({
    name: 'atlas_metric_query_targeting', help: 'Scanned documents per returned document (lower is better)',
    labelNames: ['cluster'] as const,
  }),
} as const

export function updateMetricGauges(clusterName: string, metrics: NormalizedMetrics): void {
  atlasGauges.connections.set(     { cluster: clusterName }, metrics.connections)
  atlasGauges.cpuNormalizedPct.set({ cluster: clusterName }, metrics.cpuNormalizedPct)
  atlasGauges.memoryUsedPct.set(   { cluster: clusterName }, metrics.memoryUsedPct)
  atlasGauges.diskUsedGb.set(      { cluster: clusterName }, metrics.diskUsedGb)
  atlasGauges.diskQueueDepth.set(  { cluster: clusterName }, metrics.diskQueueDepth)
  atlasGauges.readLatencyMs.set(   { cluster: clusterName }, metrics.readLatencyMs)
  atlasGauges.writeLatencyMs.set(  { cluster: clusterName }, metrics.writeLatencyMs)
  atlasGauges.queryTargeting.set(  { cluster: clusterName }, metrics.queryTargeting)
}

// ── 테스트용 의존성 역전 인터페이스 ──────────────────────────────

export interface CollectorRunMetrics {
  runTotal:         { inc(): void }
  runFailuresTotal: { inc(): void }
  runDuration:      { observe(secs: number): void }
  insertedTotal:    { inc(): void }
}

export const defaultRunMetrics: CollectorRunMetrics = {
  runTotal:         collectorRunTotal,
  runFailuresTotal: collectorRunFailuresTotal,
  runDuration:      collectorRunDuration,
  insertedTotal:    collectorInsertedTotal,
}

export function makeNoopMetrics(): CollectorRunMetrics {
  return {
    runTotal:         { inc: () => {} },
    runFailuresTotal: { inc: () => {} },
    runDuration:      { observe: () => {} },
    insertedTotal:    { inc: () => {} },
  }
}



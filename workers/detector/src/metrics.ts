import { Counter, Gauge, Histogram, collectDefaultMetrics } from 'prom-client'
import { startMetricsServer, startQueueDepthPoller } from '@demo/worker-utils'

export { startMetricsServer, startQueueDepthPoller }

collectDefaultMetrics({ prefix: 'detector_process_' })

// ── Detector run 메트릭 ───────────────────────────────────────────

export const detectorRunTotal = new Counter({
  name: 'detector_run_total',
  help: 'Total number of detector runs',
})

export const detectorRunFailuresTotal = new Counter({
  name: 'detector_run_failures_total',
  help: 'Total number of failed detector runs',
})

export const detectorRunDuration = new Histogram({
  name:    'detector_run_duration_seconds',
  help:    'Duration of each detector run in seconds',
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2],
})

// ── 이벤트 카운터 ─────────────────────────────────────────────────

export const detectorEventsTotal = new Counter({
  name:       'detector_events_total',
  help:       'Total number of new bottleneck events created',
  labelNames: ['type', 'severity'] as const,
})

export const detectorEventsResolved = new Counter({
  name:       'detector_events_resolved_total',
  help:       'Total number of bottleneck events auto-resolved',
  labelNames: ['type'] as const,
})

export const detectorEventsEscalated = new Counter({
  name:       'detector_events_escalated_total',
  help:       'Total number of bottleneck events escalated to higher severity',
  labelNames: ['type'] as const,
})

// ── 현재 상태 Gauge ───────────────────────────────────────────────

export const detectorQueueDepth = new Gauge({
  name:       'detector_queue_depth',
  help:       'Number of jobs waiting or active in the detector BullMQ queue',
  labelNames: ['state'] as const,
})

export const detectorOpenEvents = new Gauge({
  name:       'detector_open_events',
  help:       'Number of currently open bottleneck events per cluster',
  labelNames: ['cluster'] as const,
})

/**
 * open 이벤트 수를 Gauge에 기록한다. 탐지 사이클마다 호출한다.
 */
export function setOpenEventsGauge(clusterName: string, count: number): void {
  detectorOpenEvents.set({ cluster: clusterName }, count)
}

// ── 테스트용 의존성 역전 인터페이스 ──────────────────────────────

export interface DetectorRunMetrics {
  runTotal:          { inc(): void }
  runFailuresTotal:  { inc(): void }
  runDuration:       { observe(secs: number): void }
  eventsTotal:       { inc(labels: { type: string; severity: string }): void }
  eventsResolved:    { inc(labels: { type: string }): void }
  eventsEscalated:   { inc(labels: { type: string }): void }
}

export const defaultRunMetrics: DetectorRunMetrics = {
  runTotal:         detectorRunTotal,
  runFailuresTotal: detectorRunFailuresTotal,
  runDuration:      detectorRunDuration,
  eventsTotal:      detectorEventsTotal,
  eventsResolved:   detectorEventsResolved,
  eventsEscalated:  detectorEventsEscalated,
}

export function makeNoopMetrics(): DetectorRunMetrics {
  return {
    runTotal:         { inc: () => {} },
    runFailuresTotal: { inc: () => {} },
    runDuration:      { observe: () => {} },
    eventsTotal:      { inc: () => {} },
    eventsResolved:   { inc: () => {} },
    eventsEscalated:  { inc: () => {} },
  }
}



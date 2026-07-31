import { Counter, Gauge, Histogram, collectDefaultMetrics } from 'prom-client'
import { startMetricsServer, startQueueDepthPoller } from '@demo/worker-utils'

export { startMetricsServer, startQueueDepthPoller }

collectDefaultMetrics({ prefix: 'actuator_process_' })

// ── Actuator run 메트릭 ───────────────────────────────────────────

export const actuatorRunTotal = new Counter({
  name: 'actuator_run_total',
  help: 'Total number of actuator evaluation cycles',
})

export const actuatorRunDuration = new Histogram({
  name:    'actuator_run_duration_seconds',
  help:    'Duration of each actuator evaluation cycle in seconds',
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5],
})

export const actuatorActionFailuresTotal = new Counter({
  name: 'actuator_action_failures_total',
  help: 'Total number of failed actuator evaluation cycles',
})

// ── 액션 생성 카운터 ──────────────────────────────────────────────

export const actuatorActionsTotal = new Counter({
  name:       'actuator_actions_total',
  help:       'Total number of actuator actions created',
  labelNames: ['action_type', 'mode'] as const,
})

export const actuatorActionsSkipped = new Counter({
  name:       'actuator_actions_skipped_total',
  help:       'Total number of actions skipped by guardrails',
  labelNames: ['reason'] as const,
})

// ── Approval 카운터 ───────────────────────────────────────────────

export const actuatorApprovalsTotal = new Counter({
  name:       'actuator_approvals_total',
  help:       'Total number of actuator action approvals and rejections',
  labelNames: ['decision'] as const,  // 'approved' | 'rejected'
})

// ── 큐 깊이 Gauge ─────────────────────────────────────────────────

export const actuatorQueueDepth = new Gauge({
  name:       'actuator_queue_depth',
  help:       'Number of jobs waiting or active in the actuator BullMQ queue',
  labelNames: ['state'] as const,
})

// ── 테스트용 의존성 역전 인터페이스 ──────────────────────────────

export interface ActuatorRunMetrics {
  actionsTotal:   { inc(labels: { action_type: string; mode: string }): void }
  actionFailures: { inc(): void }
  actionsSkipped: { inc(labels: { reason: string }): void }
  runTotal:       { inc(): void }
  runDuration:    { observe(secs: number): void }
}

export const defaultRunMetrics: ActuatorRunMetrics = {
  actionsTotal:   actuatorActionsTotal,
  actionFailures: actuatorActionFailuresTotal,
  actionsSkipped: actuatorActionsSkipped,
  runTotal:       actuatorRunTotal,
  runDuration:    actuatorRunDuration,
}

export function makeNoopMetrics(): ActuatorRunMetrics {
  return {
    actionsTotal:   { inc: () => {} },
    actionFailures: { inc: () => {} },
    actionsSkipped: { inc: () => {} },
    runTotal:       { inc: () => {} },
    runDuration:    { observe: () => {} },
  }
}

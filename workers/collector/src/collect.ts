import type { MetricsAdapter } from '@demo/atlas'
import { insertMetrics, clampMetrics, type Db } from '@demo/shared'
import { updateMetricGauges } from './metrics.js'
import type { CollectorRunMetrics } from './metrics.js'

export interface CollectAndPersistOptions {
  adapter:        MetricsAdapter
  db:             Db | null     // null = DB 없이 실행 (mock-only 개발 모드)
  clusterName:    string
  prom:           CollectorRunMetrics
  /** Gauge 업데이트를 건너뛸지 여부. 기본 false (테스트에서 true 가능) */
  skipGauges?:    boolean
}

export interface CollectResult {
  clusterName: string
  source:      string
  durationMs:  number
  inserted:    boolean
  metrics:     ReturnType<typeof clampMetrics>
}

/**
 * 단일 수집 사이클을 실행한다.
 *
 * 흐름:
 *   1. adapter.collect()          → MetricsAdapterResult (raw)
 *   2. clampMetrics()             → 값 범위 보정 (음수·초과값 제거)
 *   3. updateMetricGauges()       → Prometheus Gauge에 현재 값 기록
 *   4. insertMetrics()            → atlas_metrics_ts time-series insert (DB 있을 때만)
 *   5. prom 카운터/히스토그램 업데이트
 *
 * 설계 원칙:
 *   - adapter, db, prom 모두 주입받아 스케줄링·BullMQ와 완전히 분리
 *   - 오류는 상위로 전파 (BullMQ가 재시도 처리)
 *   - clampMetrics는 항상 실행 — 어댑터 버그로부터 저장소를 보호
 */
export async function collectAndPersist(
  opts: CollectAndPersistOptions,
): Promise<CollectResult> {
  const { adapter, db, clusterName, prom, skipGauges = false } = opts
  const startedAt = Date.now()

  // 1. 어댑터에서 메트릭 수집
  const raw = await adapter.collect(clusterName)
  const durationMs = Date.now() - startedAt

  // 2. 값 범위 보정 (음수 제거, % 필드 0–100 제한)
  const metrics = clampMetrics(raw.metrics)

  // 3. Prometheus Gauge 업데이트 (최신 메트릭 값 노출)
  if (!skipGauges) {
    updateMetricGauges(clusterName, metrics)
  }

  // 4. MongoDB time-series insert (DB 있을 때만)
  let inserted = false
  if (db) {
    await insertMetrics(db, {
      clusterName: raw.clusterName,
      projectId:   raw.projectId,
      source:      raw.source,
      metrics,                    // 클램핑된 값 저장
      timestamp:   raw.timestamp,
    })
    prom.insertedTotal.inc()
    inserted = true
  }

  // 5. run 메트릭 업데이트
  prom.runTotal.inc()
  prom.runDuration.observe(durationMs / 1000)

  return {
    clusterName: raw.clusterName,
    source:      raw.source,
    durationMs,
    inserted,
    metrics,
  }
}

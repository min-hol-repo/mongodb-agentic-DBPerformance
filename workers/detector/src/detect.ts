import type { NormalizedMetrics, BottleneckType } from '@demo/shared'
import {
  queryRecentMetrics,
  insertEvent,
  findOpenEventByType,
  updateEventStatus,
  escalateEvent,
  type Db,
} from '@demo/shared'
import type { RuleEngine, RuleResult } from '@demo/rules'
import type { DetectorRunMetrics } from './metrics.js'

// ── 타입 ─────────────────────────────────────────────────────────

export interface DetectAndPersistOptions {
  db:              Db | null
  clusterName:     string
  projectId?:      string
  engine:          RuleEngine
  windowMinutes:   number
  prom:            DetectorRunMetrics
  minDataPoints?:  number
  /** 테스트용: DB 조회 없이 직접 points 주입 */
  injectedPoints?: NormalizedMetrics[]
}

export interface DetectResult {
  clusterName:      string
  pointsFound:      number
  results:          RuleResult[]
  eventsCreated:    number
  eventsEscalated:  number
  eventsResolved:   number
  eventsSuppressed: number
}

// 4가지 병목 타입 전체 목록 — auto-resolution 순회에 사용
const ALL_TYPES: BottleneckType[] = [
  'connection_pressure',
  'cpu_saturation',
  'storage_bottleneck',
  'query_inefficiency',
]

const SEVERITY_RANK: Record<string, number> = { low: 1, medium: 2, high: 3 }

/**
 * 단일 탐지 사이클을 실행한다.
 *
 * 흐름:
 *   1. MongoDB에서 슬라이딩 윈도우 메트릭 조회 (또는 injectedPoints 사용)
 *   2. 데이터 포인트 부족 시 조기 종료
 *   3. RuleEngine으로 모든 룰 평가
 *   4. 각 firing 결과 처리:
 *      - open 이벤트 없음          → 신규 이벤트 insert
 *      - severity 상승              → 기존 이벤트 에스컬레이션
 *      - severity 동일/하락         → 중복 억제(skip)
 *   5. 이번 사이클에 firing하지 않은 타입 중 open 이벤트 → auto-resolved
 *   6. Prometheus 카운터/히스토그램 업데이트
 *
 * 설계 원칙:
 *   - db, engine, prom 모두 주입받아 BullMQ·환경변수와 완전 분리
 *   - db = null이면 평가만 하고 DB 조작 없이 결과 반환 (mock-only 모드)
 *   - injectedPoints로 DB 없이 룰 평가 가능 (단위 테스트용)
 */
export async function detectAndPersist(
  opts: DetectAndPersistOptions,
): Promise<DetectResult> {
  const {
    db,
    clusterName,
    projectId = 'unknown-project',
    engine,
    windowMinutes,
    prom,
    minDataPoints = 1,
    injectedPoints,
  } = opts

  const startedAt = Date.now()

  // 1. 메트릭 포인트 수집
  let points: NormalizedMetrics[]

  if (injectedPoints !== undefined) {
    points = injectedPoints
  } else if (db) {
    const docs = await queryRecentMetrics(db, clusterName, windowMinutes)
    points = docs.map(d => d.metrics)
  } else {
    points = []
  }

  // 2. 데이터 부족 시 조기 종료
  if (points.length < minDataPoints) {
    console.log(
      `[detector] ${clusterName}: only ${points.length} point(s) in ${windowMinutes}min window ` +
      `(need ≥ ${minDataPoints}) — skipping`,
    )
    prom.runTotal.inc()
    prom.runDuration.observe((Date.now() - startedAt) / 1000)
    return { clusterName, pointsFound: points.length, results: [], eventsCreated: 0, eventsEscalated: 0, eventsResolved: 0, eventsSuppressed: 0 }
  }

  // 3. 룰 평가
  const now = new Date()
  const results = engine.evaluate({
    clusterName,
    windowStart: new Date(now.getTime() - windowMinutes * 60 * 1000),
    windowEnd:   now,
    points,
  })

  // 4. 각 firing 결과 처리
  let eventsCreated    = 0
  let eventsEscalated  = 0
  let eventsSuppressed = 0
  const firedTypes     = new Set(results.map(r => r.type))

  for (const result of results) {
    const existing = db ? await findOpenEventByType(db, clusterName, result.type) : null

    if (!existing) {
      // 신규 이벤트 (DB 있을 때만 실제 저장 + 카운터 증가)
      if (db) {
        await insertEvent(db, {
          timestamp:          now,
          projectId,
          clusterName,
          severity:           result.severity,
          type:               result.type,
          ruleId:             result.ruleId,
          summary:            result.summary,
          recommendedActions: result.recommendedActions,
          status:             'open',
          signals:            result.signals,
        })
        eventsCreated++
        prom.eventsTotal.inc({ type: result.type, severity: result.severity })
        console.log(`[detector] NEW  ${result.type} | ${result.severity} | ${clusterName}`)
      }
    } else if (
      SEVERITY_RANK[result.severity] > SEVERITY_RANK[existing.severity]
    ) {
      // 에스컬레이션 (severity 상승, DB 있을 때만)
      if (db) {
        await escalateEvent(db, existing._id, result.severity, result.summary, result.signals)
        eventsEscalated++
        prom.eventsEscalated.inc({ type: result.type })
        console.log(
          `[detector] ESC  ${result.type} | ${existing.severity} → ${result.severity} | ${clusterName}`,
        )
      }
    } else {
      // 중복 억제 (existing이 있을 때만 발생 = DB 있을 때)
      if (db) eventsSuppressed++
    }
  }

  // 5. Auto-resolution: firing 안 한 타입 중 open 이벤트 → resolved
  let eventsResolved = 0
  if (db) {
    for (const type of ALL_TYPES) {
      if (firedTypes.has(type)) continue
      const existing = await findOpenEventByType(db, clusterName, type)
      if (existing) {
        await updateEventStatus(db, existing._id, 'resolved')
        eventsResolved++
        prom.eventsResolved.inc({ type })
        console.log(`[detector] RES  ${type} | ${clusterName}`)
      }
    }
  }

  // 6. Prometheus 업데이트
  prom.runTotal.inc()
  prom.runDuration.observe((Date.now() - startedAt) / 1000)

  return {
    clusterName,
    pointsFound:      points.length,
    results,
    eventsCreated,
    eventsEscalated,
    eventsResolved,
    eventsSuppressed,
  }
}

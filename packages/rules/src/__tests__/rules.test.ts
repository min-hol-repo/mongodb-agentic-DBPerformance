/**
 * 규칙 엔진 단위 테스트
 *
 * 범위:
 *   1. stats 헬퍼 함수
 *   2. RULE_CONN_001 — 트리거, severity, 보수적 scale 정책
 *   3. RULE_CPU_001  — 트리거, severity, 보수적 scale 정책
 *   4. RULE_DISK_001 — 트리거, 원인별 scale 정책 분기
 *   5. RULE_QUERY_001 — 트리거, severity, scale 완전 배제, trend signal
 *   6. RuleEngine    — minPoints, 교차 우선순위(교체), severity 정렬
 */

import { describe, it, expect } from 'vitest'
import type { NormalizedMetrics } from '@demo/shared'
import {
  ConnectionPressureRule,
  CpuSaturationRule,
  StorageBottleneckRule,
  QueryInefficiencyRule,
  RuleEngine,
  avg, max, trend, exceedanceRatio,
} from '../index.js'
import { QUERY_FIRST_ACTION } from '../engine.js'
import type { RuleInput } from '../types.js'

// ── 픽스처 헬퍼 ──────────────────────────────────────────────────

function normal(): NormalizedMetrics {
  return {
    connections: 250, cpuNormalizedPct: 25, memoryUsedPct: 45,
    diskUsedGb: 120, diskQueueDepth: 0.8, readLatencyMs: 6,
    writeLatencyMs: 9, queryTargeting: 15,
  }
}

function makeInput(overrides: Partial<NormalizedMetrics> = {}, count = 3): RuleInput {
  const now = new Date()
  return {
    clusterName: 'test-cluster',
    windowStart: new Date(now.getTime() - 5 * 60 * 1000),
    windowEnd:   now,
    points:      Array.from({ length: count }, () => ({ ...normal(), ...overrides })),
  }
}

// ── stats 헬퍼 ────────────────────────────────────────────────────

describe('stats helpers', () => {
  const pts: NormalizedMetrics[] = [
    { ...normal(), connections: 100 },
    { ...normal(), connections: 200 },
    { ...normal(), connections: 300 },
  ]

  it('avg: 평균 계산', () => expect(avg(pts, 'connections')).toBeCloseTo(200))
  it('avg: 빈 배열 → 0', () => expect(avg([], 'connections')).toBe(0))
  it('max: 최댓값', () => expect(max(pts, 'connections')).toBe(300))
  it('max: 빈 배열 → 0', () => expect(max([], 'connections')).toBe(0))

  it('trend: 상승 추세 양수', () => {
    const rising = [100, 200, 300, 400].map(c => ({ ...normal(), connections: c }))
    expect(trend(rising, 'connections')).toBeGreaterThan(0)
  })

  it('trend: 하락 추세 음수', () => {
    const falling = [400, 300, 200, 100].map(c => ({ ...normal(), connections: c }))
    expect(trend(falling, 'connections')).toBeLessThan(0)
  })

  it('exceedanceRatio: 절반 초과', () => {
    const mixed = [1000, 1000, 100, 100].map(c => ({ ...normal(), connections: c }))
    expect(exceedanceRatio(mixed, 'connections', 800)).toBe(0.5)
  })
})

// ── RULE_CONN_001 ─────────────────────────────────────────────────

describe('ConnectionPressureRule (RULE_CONN_001)', () => {
  const rule = new ConnectionPressureRule()

  it('minPoints = 3', () => expect(rule.minPoints).toBe(3))
  it('connections = 500 → null', () => expect(rule.evaluate(makeInput({ connections: 500 }))).toBeNull())
  it('connections = 799 → null', () => expect(rule.evaluate(makeInput({ connections: 799 }))).toBeNull())

  it('connections = 850 → low severity', () => {
    const r = rule.evaluate(makeInput({ connections: 850, readLatencyMs: 5 }))!
    expect(r.severity).toBe('low')
    expect(r.type).toBe('connection_pressure')
  })

  it('connections = 950, low latency → medium severity', () => {
    expect(rule.evaluate(makeInput({ connections: 950, readLatencyMs: 5 }))!.severity).toBe('medium')
  })

  it('connections = 950, latency ≥ 20ms → high severity', () => {
    expect(rule.evaluate(makeInput({ connections: 950, readLatencyMs: 25 }))!.severity).toBe('high')
  })

  it('connections ≥ 1200 → high severity', () => {
    expect(rule.evaluate(makeInput({ connections: 1300 }))!.severity).toBe('high')
  })

  // ── 보수적 scale 정책 ─────────────────────────────────────────
  it('low severity → consider_scale_up 없음', () => {
    const r = rule.evaluate(makeInput({ connections: 850, readLatencyMs: 5 }))!
    expect(r.recommendedActions).not.toContain('consider_scale_up')
  })

  it('medium severity → consider_scale_up 없음', () => {
    const r = rule.evaluate(makeInput({ connections: 950, readLatencyMs: 5 }))!
    expect(r.recommendedActions).not.toContain('consider_scale_up')
  })

  it('high severity → consider_scale_up 포함 (마지막 항목)', () => {
    const r = rule.evaluate(makeInput({ connections: 1300 }))!
    expect(r.recommendedActions).toContain('consider_scale_up')
    expect(r.recommendedActions.at(-1)).toBe('consider_scale_up')
  })

  it('check_connection_pooling이 항상 첫 번째 권고', () => {
    const r = rule.evaluate(makeInput({ connections: 900 }))!
    expect(r.recommendedActions[0]).toBe('check_connection_pooling')
  })

  it('signals에 avgConnections, threshold 포함', () => {
    const r = rule.evaluate(makeInput({ connections: 900 }))!
    expect(r.signals).toHaveProperty('avgConnections')
    expect(r.signals).toHaveProperty('threshold')
  })
})

// ── RULE_CPU_001 ──────────────────────────────────────────────────

describe('CpuSaturationRule (RULE_CPU_001)', () => {
  const rule = new CpuSaturationRule()

  it('minPoints = 3', () => expect(rule.minPoints).toBe(3))
  it('cpu = 50% → null', () => expect(rule.evaluate(makeInput({ cpuNormalizedPct: 50 }))).toBeNull())
  it('cpu = 69.9% → null', () => expect(rule.evaluate(makeInput({ cpuNormalizedPct: 69.9 }))).toBeNull())

  it('cpu = 75%, low latency → medium severity', () => {
    expect(rule.evaluate(makeInput({ cpuNormalizedPct: 75, readLatencyMs: 10 }))!.severity).toBe('medium')
  })

  it('cpu = 75%, latency ≥ 30ms → high severity', () => {
    expect(rule.evaluate(makeInput({ cpuNormalizedPct: 75, readLatencyMs: 35 }))!.severity).toBe('high')
  })

  it('cpu ≥ 90% → high severity', () => {
    expect(rule.evaluate(makeInput({ cpuNormalizedPct: 92 }))!.severity).toBe('high')
  })

  // ── 보수적 scale 정책 ─────────────────────────────────────────
  it('medium severity → consider_scale_up 없음', () => {
    const r = rule.evaluate(makeInput({ cpuNormalizedPct: 75, readLatencyMs: 10 }))!
    expect(r.recommendedActions).not.toContain('consider_scale_up')
  })

  it('high severity → consider_scale_up 포함 (마지막 항목)', () => {
    const r = rule.evaluate(makeInput({ cpuNormalizedPct: 92 }))!
    expect(r.recommendedActions).toContain('consider_scale_up')
    expect(r.recommendedActions.at(-1)).toBe('consider_scale_up')
  })

  it('review_query_plans가 항상 첫 번째 권고 (query 검토 우선)', () => {
    const rMed  = rule.evaluate(makeInput({ cpuNormalizedPct: 75 }))!
    const rHigh = rule.evaluate(makeInput({ cpuNormalizedPct: 92 }))!
    expect(rMed.recommendedActions[0]).toBe('review_query_plans')
    expect(rHigh.recommendedActions[0]).toBe('review_query_plans')
  })

  it('consider_scale_up이 있을 때 query 검토 항목보다 뒤에 위치', () => {
    const r = rule.evaluate(makeInput({ cpuNormalizedPct: 92 }))!
    const scaleIdx = r.recommendedActions.indexOf('consider_scale_up')
    const queryIdx = r.recommendedActions.indexOf('review_query_plans')
    expect(queryIdx).toBeLessThan(scaleIdx)
  })
})

// ── RULE_DISK_001 ─────────────────────────────────────────────────

describe('StorageBottleneckRule (RULE_DISK_001)', () => {
  const rule = new StorageBottleneckRule()

  it('minPoints = 2', () => expect(rule.minPoints).toBe(2))
  it('정상 상태 → null', () => {
    expect(rule.evaluate(makeInput({ diskQueueDepth: 1.0, memoryUsedPct: 50 }))).toBeNull()
  })

  it('diskQueueDepth ≥ 3.0 → high', () => {
    const r = rule.evaluate(makeInput({ diskQueueDepth: 3.5 }))!
    expect(r.severity).toBe('high')
    expect(r.type).toBe('storage_bottleneck')
  })

  it('memoryUsedPct ≥ 80 → high', () => {
    expect(rule.evaluate(makeInput({ memoryUsedPct: 85, diskQueueDepth: 0.5 }))!.severity).toBe('high')
  })

  it('둘 다 임계치 미달 → null', () => {
    expect(rule.evaluate(makeInput({ diskQueueDepth: 2.9, memoryUsedPct: 79 }))).toBeNull()
  })

  it('severity는 항상 high', () => {
    expect(rule.evaluate(makeInput({ diskQueueDepth: 3.1 }))!.severity).toBe('high')
    expect(rule.evaluate(makeInput({ memoryUsedPct: 90 }))!.severity).toBe('high')
  })

  // ── 보수적 scale 정책 — 원인별 분기 ─────────────────────────
  it('diskQueueDepth 트리거 → consider_scale_up 포함', () => {
    const r = rule.evaluate(makeInput({ diskQueueDepth: 5.0 }))!
    expect(r.recommendedActions).toContain('consider_scale_up')
  })

  it('메모리만 트리거 → consider_scale_up 없음 (쿼리 개선 우선)', () => {
    const r = rule.evaluate(makeInput({ memoryUsedPct: 85, diskQueueDepth: 0.5 }))!
    expect(r.recommendedActions).not.toContain('consider_scale_up')
  })

  it('메모리만 트리거 → 쿼리/집계 최적화 권고 포함', () => {
    const r = rule.evaluate(makeInput({ memoryUsedPct: 85, diskQueueDepth: 0.5 }))!
    expect(r.recommendedActions).toContain('optimize_aggregations')
  })

  it('둘 다 트리거 → consider_scale_up 포함', () => {
    const r = rule.evaluate(makeInput({ diskQueueDepth: 4.0, memoryUsedPct: 85 }))!
    expect(r.recommendedActions).toContain('consider_scale_up')
  })

  it('signals에 diskQueueTriggered / memoryTriggered 플래그 포함', () => {
    const rDisk = rule.evaluate(makeInput({ diskQueueDepth: 4.0, memoryUsedPct: 50 }))!
    expect(rDisk.signals.diskQueueTriggered).toBe(1)
    expect(rDisk.signals.memoryTriggered).toBe(0)

    const rMem = rule.evaluate(makeInput({ diskQueueDepth: 0.5, memoryUsedPct: 85 }))!
    expect(rMem.signals.diskQueueTriggered).toBe(0)
    expect(rMem.signals.memoryTriggered).toBe(1)
  })
})

// ── RULE_QUERY_001 ────────────────────────────────────────────────

describe('QueryInefficiencyRule (RULE_QUERY_001)', () => {
  const rule = new QueryInefficiencyRule()

  it('minPoints = 3', () => expect(rule.minPoints).toBe(3))
  it('queryTargeting = 50 → null', () => expect(rule.evaluate(makeInput({ queryTargeting: 50 }))).toBeNull())
  it('queryTargeting = 99 → null', () => expect(rule.evaluate(makeInput({ queryTargeting: 99 }))).toBeNull())
  it('queryTargeting = 120 → low', () => expect(rule.evaluate(makeInput({ queryTargeting: 120 }))!.severity).toBe('low'))
  it('queryTargeting = 200 → medium', () => expect(rule.evaluate(makeInput({ queryTargeting: 200 }))!.severity).toBe('medium'))
  it('queryTargeting = 350 → high', () => expect(rule.evaluate(makeInput({ queryTargeting: 350 }))!.severity).toBe('high'))

  // ── scale 완전 배제 ────────────────────────────────────────────
  it('consider_scale_up 절대 없음 — low', () => {
    expect(rule.evaluate(makeInput({ queryTargeting: 120 }))!.recommendedActions).not.toContain('consider_scale_up')
  })
  it('consider_scale_up 절대 없음 — medium', () => {
    expect(rule.evaluate(makeInput({ queryTargeting: 200 }))!.recommendedActions).not.toContain('consider_scale_up')
  })
  it('consider_scale_up 절대 없음 — high', () => {
    expect(rule.evaluate(makeInput({ queryTargeting: 350 }))!.recommendedActions).not.toContain('consider_scale_up')
  })

  it('review_indexes가 첫 번째 권고', () => {
    expect(rule.evaluate(makeInput({ queryTargeting: 150 }))!.recommendedActions[0]).toBe('review_indexes')
  })

  it('analyze_slow_queries 포함', () => {
    expect(rule.evaluate(makeInput({ queryTargeting: 150 }))!.recommendedActions).toContain('analyze_slow_queries')
  })

  it('signals에 queryTargetingTrend 포함', () => {
    const r = rule.evaluate(makeInput({ queryTargeting: 200 }))!
    expect(r.signals).toHaveProperty('queryTargetingTrend')
  })

  it('signals에 exceedanceRatio 포함', () => {
    const r = rule.evaluate(makeInput({ queryTargeting: 200 }))!
    expect(r.signals).toHaveProperty('exceedanceRatio')
    expect(r.signals.exceedanceRatio).toBeGreaterThan(0)
  })

  it('악화 추세 시 summary에 언급', () => {
    // 상승 추세: 앞 절반 < 뒤 절반
    const risingPts = [100, 120, 200, 250, 300, 350].map(q => ({ ...normal(), queryTargeting: q }))
    const input: RuleInput = {
      clusterName: 'c', windowStart: new Date(), windowEnd: new Date(),
      points: risingPts,
    }
    const r = rule.evaluate(input)!
    expect(r.summary).toContain('악화')
  })
})

// ── RuleEngine ────────────────────────────────────────────────────

describe('RuleEngine', () => {
  const engine = new RuleEngine([
    new ConnectionPressureRule(),
    new CpuSaturationRule(),
    new StorageBottleneckRule(),
    new QueryInefficiencyRule(),
  ])

  it('정상 상태 → 결과 없음', () => {
    expect(engine.evaluate(makeInput())).toHaveLength(0)
  })

  it('minPoints 미달 → 해당 룰 skip', () => {
    // conn001 minPoints=3, 2개 제공 → skip
    const input: RuleInput = {
      clusterName: 'c', windowStart: new Date(), windowEnd: new Date(),
      points: Array.from({ length: 2 }, () => ({ ...normal(), connections: 1000 })),
    }
    const results = engine.evaluate(input)
    expect(results.every(r => r.type !== 'connection_pressure')).toBe(true)
  })

  it('severity 내림차순 정렬', () => {
    const input = makeInput({ diskQueueDepth: 5.0, queryTargeting: 200 })
    const results = engine.evaluate(input)
    const rank = (s: string) => ({ low: 1, medium: 2, high: 3 }[s] ?? 0)
    for (let i = 1; i < results.length; i++) {
      expect(rank(results[i - 1].severity)).toBeGreaterThanOrEqual(rank(results[i].severity))
    }
  })

  // ── 교차 우선순위: 교체 방식 ──────────────────────────────────
  it('query_inefficiency 동시 firing → conn의 consider_scale_up을 review_query_efficiency_first로 교체', () => {
    // connection_pressure(high) + query_inefficiency 동시 트리거
    const input = makeInput({ connections: 1300, queryTargeting: 200 })
    const results = engine.evaluate(input)

    const connResult  = results.find(r => r.type === 'connection_pressure')
    const queryResult = results.find(r => r.type === 'query_inefficiency')

    expect(queryResult).toBeDefined()
    expect(connResult).toBeDefined()

    // 제거가 아닌 교체여야 함
    expect(connResult!.recommendedActions).not.toContain('consider_scale_up')
    expect(connResult!.recommendedActions).toContain(QUERY_FIRST_ACTION)
  })

  it('query_inefficiency 없으면 high severity conn에 consider_scale_up 유지', () => {
    const results = engine.evaluate(makeInput({ connections: 1300 }))
    const connResult = results.find(r => r.type === 'connection_pressure')
    expect(connResult!.recommendedActions).toContain('consider_scale_up')
    expect(connResult!.recommendedActions).not.toContain(QUERY_FIRST_ACTION)
  })

  it('query_inefficiency가 low/medium conn에 firing해도 교체 대상 없음 (이미 scale 없음)', () => {
    // medium conn (no scale) + query
    const input = makeInput({ connections: 950, readLatencyMs: 5, queryTargeting: 200 })
    const results = engine.evaluate(input)
    const connResult = results.find(r => r.type === 'connection_pressure')
    // medium이라 원래 scale 없음 → QUERY_FIRST_ACTION도 없음
    expect(connResult!.recommendedActions).not.toContain('consider_scale_up')
    expect(connResult!.recommendedActions).not.toContain(QUERY_FIRST_ACTION)
  })

  it('query_inefficiency 자체 권고는 교체되지 않음', () => {
    const results = engine.evaluate(makeInput({ connections: 1300, queryTargeting: 200 }))
    const queryResult = results.find(r => r.type === 'query_inefficiency')!
    expect(queryResult.recommendedActions).toContain('review_indexes')
    expect(queryResult.recommendedActions).not.toContain(QUERY_FIRST_ACTION)
  })

  it('4개 룰 모두 동시 트리거 가능', () => {
    const input = makeInput({ connections: 950, cpuNormalizedPct: 80, diskQueueDepth: 4.0, queryTargeting: 200 })
    const results = engine.evaluate(input)
    expect(results).toHaveLength(4)
    const types = results.map(r => r.type)
    expect(types).toContain('connection_pressure')
    expect(types).toContain('cpu_saturation')
    expect(types).toContain('storage_bottleneck')
    expect(types).toContain('query_inefficiency')
  })
})

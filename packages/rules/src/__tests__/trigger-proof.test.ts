/**
 * 결정론적 트리거 증명 테스트 (Deterministic Trigger Proof)
 *
 * 목적:
 *   각 룰이 정확히 어떤 메트릭 값에서 트리거되는지를 증명한다.
 *   - 노이즈 없는 고정값 사용 (Math.random 완전 배제)
 *   - 임계치 경계 바로 아래 → null
 *   - 임계치 경계 이상     → 트리거
 *   - 각 severity 레벨도 별도로 검증
 *
 * 이 파일 하나만 읽으면 모든 룰의 트리거 조건을 파악할 수 있다.
 */

import { describe, it, expect } from 'vitest'
import type { NormalizedMetrics } from '@demo/shared'
import {
  ConnectionPressureRule,
  CpuSaturationRule,
  StorageBottleneckRule,
  QueryInefficiencyRule,
  RuleEngine,
} from '../index.js'
import type { RuleInput } from '../types.js'

// ── 공통 헬퍼 ────────────────────────────────────────────────────

/** 정상 범위 베이스라인 — 어떤 룰도 트리거하지 않는다. */
const NORMAL_BASELINE: NormalizedMetrics = {
  connections:      250,
  cpuNormalizedPct:  25,
  memoryUsedPct:     45,
  diskUsedGb:       120,
  diskQueueDepth:   0.8,
  readLatencyMs:      6,
  writeLatencyMs:     9,
  queryTargeting:    15,
}

/** N개의 동일한 포인트로 RuleInput을 생성한다. 노이즈 없음. */
function exactInput(metrics: Partial<NormalizedMetrics>, count = 5): RuleInput {
  const now = new Date('2026-01-01T00:00:00Z')     // 고정 시각 — 결정론 보장
  const points = Array.from({ length: count }, () => ({
    ...NORMAL_BASELINE,
    ...metrics,
  }))
  return {
    clusterName: 'proof-cluster',
    windowStart: new Date(now.getTime() - 5 * 60 * 1000),
    windowEnd:   now,
    points,
  }
}

// ── 임계치 표 ─────────────────────────────────────────────────────
//
// RULE       FIELD              THRESHOLD  LOW    MEDIUM  HIGH
// CONN_001   connections        800        800    900     1200
//                               + latency  -      -       ≥20ms
// CPU_001    cpuNormalizedPct   70         70     70      90 or latency≥30
// DISK_001   diskQueueDepth     3.0        3.0    3.0     3.0 (always high)
//            memoryUsedPct      80         80     80      80  (always high)
// QUERY_001  queryTargeting     100        100    150     300

// ─────────────────────────────────────────────────────────────────
// RULE_CONN_001: Connection Pressure
// ─────────────────────────────────────────────────────────────────

describe('RULE_CONN_001 — connection_pressure 트리거 증명', () => {
  const rule = new ConnectionPressureRule()

  // ── 트리거 경계 ───────────────────────────────────────────────
  it('[임계치 미달] connections=799 → null', () => {
    expect(rule.evaluate(exactInput({ connections: 799 }))).toBeNull()
  })

  it('[임계치 정확] connections=800 → 트리거 (low)', () => {
    const r = rule.evaluate(exactInput({ connections: 800, readLatencyMs: 5 }))
    expect(r).not.toBeNull()
    expect(r!.type).toBe('connection_pressure')
    expect(r!.severity).toBe('low')
  })

  it('[저부하] connections=850, latency=5ms → low', () => {
    const r = rule.evaluate(exactInput({ connections: 850, readLatencyMs: 5 }))!
    expect(r.severity).toBe('low')
    expect(r.signals.avgConnections).toBe(850)
    expect(r.signals.threshold).toBe(800)
  })

  it('[중부하] connections=950, latency=10ms → medium', () => {
    const r = rule.evaluate(exactInput({ connections: 950, readLatencyMs: 10 }))!
    expect(r.severity).toBe('medium')
  })

  it('[고부하] connections=950, latency=20ms → high (latency 조건)', () => {
    const r = rule.evaluate(exactInput({ connections: 950, readLatencyMs: 20 }))!
    expect(r.severity).toBe('high')
  })

  it('[위험] connections=1200 → high (connections 조건)', () => {
    const r = rule.evaluate(exactInput({ connections: 1200 }))!
    expect(r.severity).toBe('high')
  })

  it('[위험+] connections=1500 → high', () => {
    const r = rule.evaluate(exactInput({ connections: 1500 }))!
    expect(r.severity).toBe('high')
    expect(r.signals.avgConnections).toBe(1500)
  })

  // ── 스케일 권고 정책 검증 ─────────────────────────────────────
  it('[정책] low/medium → scale 권고 없음', () => {
    const low = rule.evaluate(exactInput({ connections: 850 }))!
    const med = rule.evaluate(exactInput({ connections: 950, readLatencyMs: 10 }))!
    expect(low.recommendedActions).not.toContain('consider_scale_up')
    expect(med.recommendedActions).not.toContain('consider_scale_up')
  })

  it('[정책] high → scale 권고 있고 마지막 항목', () => {
    const r = rule.evaluate(exactInput({ connections: 1300 }))!
    expect(r.recommendedActions).toContain('consider_scale_up')
    expect(r.recommendedActions.at(-1)).toBe('consider_scale_up')
  })

  // ── minPoints 요건 ────────────────────────────────────────────
  it('[minPoints] 포인트 2개 → 엔진이 skip (minPoints=3)', () => {
    const engine = new RuleEngine([rule])
    const input  = exactInput({ connections: 1300 }, 2)  // 2개만
    expect(engine.evaluate(input)).toHaveLength(0)
  })
})

// ─────────────────────────────────────────────────────────────────
// RULE_CPU_001: CPU Saturation
// ─────────────────────────────────────────────────────────────────

describe('RULE_CPU_001 — cpu_saturation 트리거 증명', () => {
  const rule = new CpuSaturationRule()

  it('[임계치 미달] cpu=69.9% → null', () => {
    expect(rule.evaluate(exactInput({ cpuNormalizedPct: 69.9 }))).toBeNull()
  })

  it('[임계치 정확] cpu=70% → 트리거 (medium)', () => {
    const r = rule.evaluate(exactInput({ cpuNormalizedPct: 70, readLatencyMs: 10 }))
    expect(r).not.toBeNull()
    expect(r!.type).toBe('cpu_saturation')
    expect(r!.severity).toBe('medium')
  })

  it('[중부하] cpu=75%, latency=10ms → medium', () => {
    const r = rule.evaluate(exactInput({ cpuNormalizedPct: 75, readLatencyMs: 10 }))!
    expect(r.severity).toBe('medium')
    expect(r.signals.avgCpuPct).toBe(75)
    expect(r.signals.threshold).toBe(70)
  })

  it('[고부하] cpu=75%, latency=30ms → high (latency 조건)', () => {
    const r = rule.evaluate(exactInput({ cpuNormalizedPct: 75, readLatencyMs: 30 }))!
    expect(r.severity).toBe('high')
  })

  it('[위험] cpu=90% → high (critical 조건)', () => {
    const r = rule.evaluate(exactInput({ cpuNormalizedPct: 90 }))!
    expect(r.severity).toBe('high')
  })

  it('[위험+] cpu=95% → high', () => {
    const r = rule.evaluate(exactInput({ cpuNormalizedPct: 95 }))!
    expect(r.severity).toBe('high')
    expect(r.signals.avgCpuPct).toBe(95)
  })

  // ── 스케일 권고 정책 검증 ─────────────────────────────────────
  it('[정책] medium → scale 없고 review_query_plans 첫 번째', () => {
    const r = rule.evaluate(exactInput({ cpuNormalizedPct: 75, readLatencyMs: 10 }))!
    expect(r.recommendedActions).not.toContain('consider_scale_up')
    expect(r.recommendedActions[0]).toBe('review_query_plans')
  })

  it('[정책] high → scale 있고 query 검토보다 뒤에', () => {
    const r = rule.evaluate(exactInput({ cpuNormalizedPct: 92 }))!
    const qi = r.recommendedActions.indexOf('review_query_plans')
    const si = r.recommendedActions.indexOf('consider_scale_up')
    expect(si).toBeGreaterThan(-1)
    expect(qi).toBeLessThan(si)
  })

  it('[minPoints] 포인트 2개 → skip', () => {
    const engine = new RuleEngine([rule])
    expect(engine.evaluate(exactInput({ cpuNormalizedPct: 95 }, 2))).toHaveLength(0)
  })
})

// ─────────────────────────────────────────────────────────────────
// RULE_DISK_001: Storage Bottleneck
// ─────────────────────────────────────────────────────────────────

describe('RULE_DISK_001 — storage_bottleneck 트리거 증명', () => {
  const rule = new StorageBottleneckRule()

  it('[임계치 미달] diskQueueDepth=2.9, memory=79% → null', () => {
    expect(rule.evaluate(exactInput({ diskQueueDepth: 2.9, memoryUsedPct: 79 }))).toBeNull()
  })

  // 경로 A: diskQueueDepth 트리거
  it('[경로A 정확] diskQueueDepth=3.0 → 트리거 (high)', () => {
    const r = rule.evaluate(exactInput({ diskQueueDepth: 3.0, memoryUsedPct: 50 }))
    expect(r).not.toBeNull()
    expect(r!.type).toBe('storage_bottleneck')
    expect(r!.severity).toBe('high')
  })

  it('[경로A] diskQueueDepth=4.5 → high, scale 권고 포함', () => {
    const r = rule.evaluate(exactInput({ diskQueueDepth: 4.5 }))!
    expect(r.severity).toBe('high')
    expect(r.signals.diskQueueTriggered).toBe(1)
    expect(r.recommendedActions).toContain('consider_scale_up')
  })

  it('[경로A 위험] diskQueueDepth=6.0 → 즉각 대응 메시지', () => {
    const r = rule.evaluate(exactInput({ diskQueueDepth: 6.0 }))!
    expect(r.summary).toContain('즉각')
  })

  // 경로 B: 메모리 고사용률만 트리거
  it('[경로B 정확] memoryUsedPct=80%, diskQueue=0.5 → 트리거 (high)', () => {
    const r = rule.evaluate(exactInput({ memoryUsedPct: 80, diskQueueDepth: 0.5 }))
    expect(r).not.toBeNull()
    expect(r!.severity).toBe('high')
  })

  it('[경로B 정책] 메모리만 트리거 → scale 없음, 쿼리 최적화 권고', () => {
    const r = rule.evaluate(exactInput({ memoryUsedPct: 85, diskQueueDepth: 0.5 }))!
    expect(r.signals.memoryTriggered).toBe(1)
    expect(r.signals.diskQueueTriggered).toBe(0)
    expect(r.recommendedActions).not.toContain('consider_scale_up')
    expect(r.recommendedActions).toContain('optimize_aggregations')
  })

  // 경로 C: 두 조건 모두 트리거
  it('[경로C] 둘 다 트리거 → high, scale 포함', () => {
    const r = rule.evaluate(exactInput({ diskQueueDepth: 4.0, memoryUsedPct: 85 }))!
    expect(r.signals.diskQueueTriggered).toBe(1)
    expect(r.signals.memoryTriggered).toBe(1)
    expect(r.recommendedActions).toContain('consider_scale_up')
  })

  it('[severity 고정] 항상 high (low/medium 없음)', () => {
    // 어느 조건이든 high
    const rQueue  = rule.evaluate(exactInput({ diskQueueDepth: 3.1 }))!
    const rMemory = rule.evaluate(exactInput({ memoryUsedPct: 90 }))!
    const rBoth   = rule.evaluate(exactInput({ diskQueueDepth: 7.0, memoryUsedPct: 95 }))!
    expect(rQueue.severity).toBe('high')
    expect(rMemory.severity).toBe('high')
    expect(rBoth.severity).toBe('high')
  })

  it('[minPoints] 포인트 1개 → skip (minPoints=2)', () => {
    const engine = new RuleEngine([rule])
    expect(engine.evaluate(exactInput({ diskQueueDepth: 5.0 }, 1))).toHaveLength(0)
  })
})

// ─────────────────────────────────────────────────────────────────
// RULE_QUERY_001: Query Inefficiency
// ─────────────────────────────────────────────────────────────────

describe('RULE_QUERY_001 — query_inefficiency 트리거 증명', () => {
  const rule = new QueryInefficiencyRule()

  it('[임계치 미달] queryTargeting=99 → null', () => {
    expect(rule.evaluate(exactInput({ queryTargeting: 99 }))).toBeNull()
  })

  it('[임계치 정확] queryTargeting=100 → 트리거 (low)', () => {
    const r = rule.evaluate(exactInput({ queryTargeting: 100 }))
    expect(r).not.toBeNull()
    expect(r!.type).toBe('query_inefficiency')
    expect(r!.severity).toBe('low')
  })

  it('[저효율] queryTargeting=120 → low', () => {
    const r = rule.evaluate(exactInput({ queryTargeting: 120 }))!
    expect(r.severity).toBe('low')
    expect(r.signals.avgQueryTargeting).toBe(120)
    expect(r.signals.threshold).toBe(100)
  })

  it('[중효율] queryTargeting=150 → medium', () => {
    const r = rule.evaluate(exactInput({ queryTargeting: 150 }))!
    expect(r.severity).toBe('medium')
  })

  it('[중효율+] queryTargeting=200 → medium', () => {
    const r = rule.evaluate(exactInput({ queryTargeting: 200 }))!
    expect(r.severity).toBe('medium')
  })

  it('[고효율] queryTargeting=300 → high', () => {
    const r = rule.evaluate(exactInput({ queryTargeting: 300 }))!
    expect(r.severity).toBe('high')
  })

  it('[풀스캔] queryTargeting=500 → high', () => {
    const r = rule.evaluate(exactInput({ queryTargeting: 500 }))!
    expect(r.severity).toBe('high')
    expect(r.signals.avgQueryTargeting).toBe(500)
  })

  // ── scale 완전 배제 검증 ──────────────────────────────────────
  it('[정책] 모든 severity에서 scale 권고 절대 없음', () => {
    const low  = rule.evaluate(exactInput({ queryTargeting: 120 }))!
    const med  = rule.evaluate(exactInput({ queryTargeting: 200 }))!
    const high = rule.evaluate(exactInput({ queryTargeting: 500 }))!
    for (const r of [low, med, high]) {
      expect(r.recommendedActions).not.toContain('consider_scale_up')
      expect(r.recommendedActions[0]).toBe('review_indexes')
    }
  })

  // ── 추세(trend) signal 검증 ───────────────────────────────────
  it('[trend] 상승 추세 → queryTargetingTrend > 0', () => {
    const now = new Date('2026-01-01T00:00:00Z')
    const rising = [100, 120, 150, 180, 210, 250].map(q => ({
      ...NORMAL_BASELINE, queryTargeting: q,
    }))
    const r = rule.evaluate({
      clusterName: 'proof-cluster',
      windowStart: new Date(now.getTime() - 5 * 60 * 1000),
      windowEnd:   now,
      points:      rising,
    })!
    expect(r.signals.queryTargetingTrend).toBeGreaterThan(0)
  })

  it('[trend] 하락 추세 → queryTargetingTrend < 0', () => {
    const now = new Date('2026-01-01T00:00:00Z')
    const falling = [250, 200, 160, 130, 110, 100].map(q => ({
      ...NORMAL_BASELINE, queryTargeting: q,
    }))
    const r = rule.evaluate({
      clusterName: 'proof-cluster',
      windowStart: new Date(now.getTime() - 5 * 60 * 1000),
      windowEnd:   now,
      points:      falling,
    })!
    expect(r.signals.queryTargetingTrend).toBeLessThan(0)
  })

  it('[minPoints] 포인트 2개 → skip (minPoints=3)', () => {
    const engine = new RuleEngine([rule])
    expect(engine.evaluate(exactInput({ queryTargeting: 500 }, 2))).toHaveLength(0)
  })
})

// ─────────────────────────────────────────────────────────────────
// 전체 트리거 매트릭스 — 4개 룰이 모두 트리거됨을 한 번에 증명
// ─────────────────────────────────────────────────────────────────

describe('전체 트리거 매트릭스 — 모든 룰이 트리거됨을 증명', () => {
  const engine = new RuleEngine([
    new ConnectionPressureRule(),
    new CpuSaturationRule(),
    new StorageBottleneckRule(),
    new QueryInefficiencyRule(),
  ])

  /**
   * 각 시나리오별 트리거 매트릭스.
   * format: [scenarioName, metrics, expectedTypes[]]
   */
  const TRIGGER_MATRIX: Array<{
    scenario:      string
    metrics:       Partial<NormalizedMetrics>
    expectedTypes: string[]
    notExpected:   string[]
  }> = [
    {
      scenario: 'normal',
      metrics:  {},
      expectedTypes: [],
      notExpected:   ['connection_pressure', 'cpu_saturation', 'storage_bottleneck', 'query_inefficiency'],
    },
    {
      scenario:      'connection_surge (connections=950)',
      metrics:       { connections: 950, readLatencyMs: 10 },
      expectedTypes: ['connection_pressure'],
      notExpected:   ['cpu_saturation', 'storage_bottleneck', 'query_inefficiency'],
    },
    {
      scenario:      'cpu_saturation (cpu=85%)',
      metrics:       { cpuNormalizedPct: 85, readLatencyMs: 10 },
      expectedTypes: ['cpu_saturation'],
      notExpected:   ['connection_pressure', 'storage_bottleneck', 'query_inefficiency'],
    },
    {
      scenario:      'storage_pressure (diskQueueDepth=5.0)',
      metrics:       { diskQueueDepth: 5.0, memoryUsedPct: 50 },
      expectedTypes: ['storage_bottleneck'],
      notExpected:   ['connection_pressure', 'cpu_saturation', 'query_inefficiency'],
    },
    {
      scenario:      'storage_pressure_memory (memoryUsedPct=85%)',
      metrics:       { memoryUsedPct: 85, diskQueueDepth: 0.5 },
      expectedTypes: ['storage_bottleneck'],
      notExpected:   ['connection_pressure', 'cpu_saturation', 'query_inefficiency'],
    },
    {
      scenario:      'query_inefficiency (queryTargeting=180)',
      metrics:       { queryTargeting: 180 },
      expectedTypes: ['query_inefficiency'],
      notExpected:   ['connection_pressure', 'cpu_saturation', 'storage_bottleneck'],
    },
    {
      scenario:      'all_bad (모든 룰 동시 트리거)',
      metrics:       {
        connections: 950, cpuNormalizedPct: 85,
        diskQueueDepth: 5.0, queryTargeting: 180,
      },
      expectedTypes: ['connection_pressure', 'cpu_saturation', 'storage_bottleneck', 'query_inefficiency'],
      notExpected:   [],
    },
  ]

  for (const { scenario, metrics, expectedTypes, notExpected } of TRIGGER_MATRIX) {
    it(`[매트릭스] ${scenario}`, () => {
      const results  = engine.evaluate(exactInput(metrics))
      const firedTypes = results.map(r => r.type)

      for (const t of expectedTypes) {
        expect(firedTypes, `'${t}' should fire in scenario '${scenario}'`).toContain(t)
      }
      for (const t of notExpected) {
        expect(firedTypes, `'${t}' should NOT fire in scenario '${scenario}'`).not.toContain(t)
      }
    })
  }

  it('[매트릭스 핵심] 4개 룰이 각각 최소 1회 이상 트리거됨', () => {
    const ALL_RULE_TYPES = [
      'connection_pressure',
      'cpu_saturation',
      'storage_bottleneck',
      'query_inefficiency',
    ] as const

    const triggeredOnce = new Set<string>()

    for (const { metrics } of TRIGGER_MATRIX) {
      const results = engine.evaluate(exactInput(metrics))
      results.forEach(r => triggeredOnce.add(r.type))
    }

    for (const type of ALL_RULE_TYPES) {
      expect(triggeredOnce, `Rule '${type}' must trigger at least once`).toContain(type)
    }
  })

  it('[격리] 각 시나리오는 의도한 단일 룰만 트리거한다 (cross-contamination 없음)', () => {
    const isolated = TRIGGER_MATRIX.filter(m => m.expectedTypes.length === 1)
    for (const { scenario, metrics, expectedTypes } of isolated) {
      const results = engine.evaluate(exactInput(metrics))
      expect(results, `scenario '${scenario}' should fire exactly 1 rule`).toHaveLength(1)
      expect(results[0].type).toBe(expectedTypes[0])
    }
  })
})

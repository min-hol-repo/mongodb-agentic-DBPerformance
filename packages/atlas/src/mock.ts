import type { NormalizedMetrics } from '@demo/shared'
import type { MetricsAdapter, MetricsAdapterResult } from './adapter.js'
import { addNoise } from './normalize.js'

// ── 시나리오 정의 ──────────────────────────────────────────────────

/**
 * 데모 시나리오 타입.
 * 각 시나리오는 특정 병목 탐지 룰을 트리거하도록 설계된 고정 기준값을 갖는다.
 */
export type MockScenario =
  | 'normal'             // 정상 상태 — 어떤 룰도 트리거 안 됨
  | 'connection_surge'   // RULE_CONN_001 트리거 (connections ≥ 800)
  | 'cpu_saturation'     // RULE_CPU_001 트리거 (cpu ≥ 70%)
  | 'storage_pressure'   // RULE_DISK_001 트리거 (diskQueueDepth ≥ 3 또는 memory ≥ 80%)
  | 'query_inefficiency' // RULE_QUERY_001 트리거 (queryTargeting ≥ 100)

// ── 시나리오별 기준값 ─────────────────────────────────────────────
// 각 시나리오는 결정론적인 고정 기준값을 가진다.
// collect() 호출마다 ±5% 이내의 작은 노이즈만 추가된다.

const SCENARIO_BASELINES: Record<MockScenario, NormalizedMetrics> = {
  normal: {
    connections:      250,
    cpuNormalizedPct:  25,
    memoryUsedPct:     45,
    diskUsedGb:       120,
    diskQueueDepth:   0.8,
    readLatencyMs:      6,
    writeLatencyMs:     9,
    queryTargeting:    15,
  },

  // RULE_CONN_001: connections > 800, 지연 시간도 함께 상승
  connection_surge: {
    connections:      950,
    cpuNormalizedPct:  55,
    memoryUsedPct:     62,
    diskUsedGb:       145,
    diskQueueDepth:   1.2,
    readLatencyMs:     28,
    writeLatencyMs:    35,
    queryTargeting:    18,
  },

  // RULE_CPU_001: cpuNormalizedPct > 70, 지연 시간 동반 상승
  cpu_saturation: {
    connections:      380,
    cpuNormalizedPct:  82,
    memoryUsedPct:     71,
    diskUsedGb:       130,
    diskQueueDepth:   1.5,
    readLatencyMs:     45,
    writeLatencyMs:    52,
    queryTargeting:    22,
  },

  // RULE_DISK_001: diskQueueDepth > 3 AND memoryUsedPct > 80 → high severity
  storage_pressure: {
    connections:      310,
    cpuNormalizedPct:  38,
    memoryUsedPct:     85,
    diskUsedGb:       480,
    diskQueueDepth:   4.8,
    readLatencyMs:     65,
    writeLatencyMs:    80,
    queryTargeting:    20,
  },

  // RULE_QUERY_001: queryTargeting > 100 (scale보다 인덱스 개선 먼저 권고)
  query_inefficiency: {
    connections:      290,
    cpuNormalizedPct:  48,
    memoryUsedPct:     55,
    diskUsedGb:       140,
    diskQueueDepth:   1.1,
    readLatencyMs:     18,
    writeLatencyMs:    22,
    queryTargeting:   180,
  },
}

// ── MockMetricsAdapter ────────────────────────────────────────────

export interface MockMetricsAdapterOptions {
  scenario?: MockScenario
  projectId?: string
}

/**
 * MockMetricsAdapter
 *
 * 실제 Atlas API 없이 결정론적인 시나리오 기반 메트릭을 반환한다.
 * 개발·테스트·데모 환경에서 사용한다.
 *
 * 결정론 보장:
 *   - 각 시나리오는 고정된 기준값을 갖는다.
 *   - 호출마다 ±5% 이내의 작은 노이즈만 추가되어 차트가 자연스럽게 보인다.
 *   - 시나리오가 바뀌지 않으면 항상 동일한 임계치 범위 내 값을 반환한다.
 */
export class MockMetricsAdapter implements MetricsAdapter {
  readonly name = 'mock'

  private scenario: MockScenario
  private readonly projectId: string

  constructor(opts: MockMetricsAdapterOptions = {}) {
    this.scenario = opts.scenario ?? 'normal'
    this.projectId = opts.projectId ?? 'mock-project-1'
  }

  async isAvailable(): Promise<boolean> {
    return true
  }

  /** 런타임에 시나리오를 전환한다 (데모 시 동적 전환용) */
  setScenario(scenario: MockScenario): void {
    this.scenario = scenario
  }

  getScenario(): MockScenario {
    return this.scenario
  }

  async collect(clusterName: string): Promise<MetricsAdapterResult> {
    const base = SCENARIO_BASELINES[this.scenario]

    return {
      clusterName,
      projectId: this.projectId,
      source: `mock:${this.scenario}`,
      timestamp: new Date(),
      metrics: {
        connections:       Math.round(addNoise(base.connections)),
        cpuNormalizedPct:  round1(addNoise(base.cpuNormalizedPct)),
        memoryUsedPct:     round1(addNoise(base.memoryUsedPct)),
        diskUsedGb:        round1(addNoise(base.diskUsedGb)),
        diskQueueDepth:    round2(addNoise(base.diskQueueDepth, 0.1)),
        readLatencyMs:     round1(addNoise(base.readLatencyMs)),
        writeLatencyMs:    round1(addNoise(base.writeLatencyMs)),
        queryTargeting:    Math.round(addNoise(base.queryTargeting)),
      },
    }
  }
}

/** 시나리오 기준값을 직접 반환한다 (테스트에서 임계치 검증용) */
export function getScenarioBaseline(scenario: MockScenario): NormalizedMetrics {
  return { ...SCENARIO_BASELINES[scenario] }
}

// ── 내부 헬퍼 ────────────────────────────────────────────────────
function round1(v: number): number { return Math.round(v * 10) / 10 }
function round2(v: number): number { return Math.round(v * 100) / 100 }

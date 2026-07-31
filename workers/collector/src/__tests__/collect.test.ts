/**
 * Collector Worker 테스트
 *
 * 테스트 범위:
 *   1. 8개 필드 완전성 — 모든 시나리오가 8개 필드를 빠짐없이 반환하는가
 *   2. 필드 유효 범위 — 각 필드가 스키마 조건(min/max)을 만족하는가
 *   3. clampMetrics — 비정상 값(음수, 초과 %, NaN)을 보정하는가
 *   4. NormalizedMetricsSchema — Zod 스키마 검증이 올바르게 동작하는가
 *   5. MockMetricsAdapter 시나리오 — 시나리오별 임계치를 넘는가
 *   6. collectAndPersist (단위) — DB null 모드, 클램핑 후 결과 반환
 *   7. collectAndPersist (통합) — MongoDB time-series insert 확인
 *   8. 오류 처리 — 어댑터 실패 시 상위로 전파
 *   9. normalizeAtlasResponse — raw → NormalizedMetrics 변환
 */

import { MongoClient } from 'mongodb'
import type { Db } from 'mongodb'
import { MongoMemoryServer } from 'mongodb-memory-server'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'

import {
  MockMetricsAdapter,
  getScenarioBaseline,
  normalizeAtlasResponse,
  type MockScenario,
  type AtlasRawMeasurement,
} from '@demo/atlas'
import {
  ensureCollections,
  queryRecentMetrics,
  _injectDb,
  _resetDb,
  clampMetrics,
  validateMetrics,
  NormalizedMetricsSchema,
  NORMALIZED_METRIC_FIELDS,
  METRIC_FIELD_META,
  type NormalizedMetrics,
} from '@demo/shared'
import { collectAndPersist } from '../collect.js'
import { makeNoopMetrics } from '../metrics.js'

// ── 테스트 셋업 ───────────────────────────────────────────────────

let mongod: MongoMemoryServer
let mongoClient: MongoClient
let db: Db

beforeAll(async () => {
  mongod      = await MongoMemoryServer.create()
  mongoClient = new MongoClient(mongod.getUri())
  await mongoClient.connect()
  db = mongoClient.db('collector_test')
  await ensureCollections(db)
  _injectDb(mongoClient, db)
})

afterAll(async () => {
  _resetDb()
  await mongoClient.close()
  await mongod.stop()
})

// ── 1. 8개 필드 완전성 ────────────────────────────────────────────

describe('NormalizedMetrics — 8개 필드 완전성', () => {
  const ALL_FIELDS: Array<keyof NormalizedMetrics> = [
    'connections',
    'cpuNormalizedPct',
    'memoryUsedPct',
    'diskUsedGb',
    'diskQueueDepth',
    'readLatencyMs',
    'writeLatencyMs',
    'queryTargeting',
  ]

  it('NORMALIZED_METRIC_FIELDS 에 8개 필드가 모두 정의되어 있다', () => {
    expect(NORMALIZED_METRIC_FIELDS).toHaveLength(8)
    for (const f of ALL_FIELDS) {
      expect(NORMALIZED_METRIC_FIELDS).toContain(f)
    }
  })

  it('METRIC_FIELD_META 에 8개 필드 메타데이터가 모두 있다', () => {
    for (const f of ALL_FIELDS) {
      const meta = METRIC_FIELD_META[f]
      expect(meta, `missing meta for ${f}`).toBeDefined()
      expect(meta.unit).toBeTruthy()
      expect(meta.description).toBeTruthy()
      expect(meta.atlasName).toBeTruthy()
      expect(typeof meta.min).toBe('number')
    }
  })

  const scenarios: MockScenario[] = [
    'normal', 'connection_surge', 'cpu_saturation',
    'storage_pressure', 'query_inefficiency',
  ]

  for (const scenario of scenarios) {
    it(`${scenario}: 8개 필드가 모두 존재하고 유한한 숫자다`, async () => {
      const adapter = new MockMetricsAdapter({ scenario })
      const result  = await adapter.collect('test-cluster')

      for (const field of ALL_FIELDS) {
        const value = result.metrics[field]
        expect(value, `${scenario}.${field} should be defined`).toBeDefined()
        expect(typeof value, `${scenario}.${field} should be number`).toBe('number')
        expect(isFinite(value), `${scenario}.${field} should be finite`).toBe(true)
        expect(isNaN(value),    `${scenario}.${field} should not be NaN`).toBe(false)
        expect(value, `${scenario}.${field} should be ≥ 0`).toBeGreaterThanOrEqual(0)
      }
    })
  }

  it('Zod 스키마가 정상 메트릭을 통과시킨다', () => {
    const good: NormalizedMetrics = {
      connections: 300, cpuNormalizedPct: 40, memoryUsedPct: 55,
      diskUsedGb: 120, diskQueueDepth: 1.2, readLatencyMs: 8,
      writeLatencyMs: 12, queryTargeting: 20,
    }
    expect(() => NormalizedMetricsSchema.parse(good)).not.toThrow()
  })

  it('validateMetrics()가 정상 객체를 반환한다', () => {
    const good: NormalizedMetrics = {
      connections: 100, cpuNormalizedPct: 30, memoryUsedPct: 50,
      diskUsedGb: 80, diskQueueDepth: 0.5, readLatencyMs: 5,
      writeLatencyMs: 7, queryTargeting: 10,
    }
    const result = validateMetrics(good)
    expect(result.connections).toBe(100)
  })
})

// ── 2. 필드 유효 범위 ─────────────────────────────────────────────

describe('필드 유효 범위 (Zod 스키마)', () => {
  it('connections: 음수는 Zod 에러', () => {
    expect(() => NormalizedMetricsSchema.parse({ ...validMetrics(), connections: -1 }))
      .toThrow()
  })

  it('cpuNormalizedPct: 100 초과는 Zod 에러', () => {
    expect(() => NormalizedMetricsSchema.parse({ ...validMetrics(), cpuNormalizedPct: 101 }))
      .toThrow()
  })

  it('memoryUsedPct: 음수는 Zod 에러', () => {
    expect(() => NormalizedMetricsSchema.parse({ ...validMetrics(), memoryUsedPct: -5 }))
      .toThrow()
  })

  it('connections: 정수가 아니면 Zod 에러', () => {
    expect(() => NormalizedMetricsSchema.parse({ ...validMetrics(), connections: 100.5 }))
      .toThrow()
  })

  it('readLatencyMs / writeLatencyMs: 음수는 Zod 에러', () => {
    expect(() => NormalizedMetricsSchema.parse({ ...validMetrics(), readLatencyMs: -1 })).toThrow()
    expect(() => NormalizedMetricsSchema.parse({ ...validMetrics(), writeLatencyMs: -1 })).toThrow()
  })

  it('queryTargeting: 음수는 Zod 에러', () => {
    expect(() => NormalizedMetricsSchema.parse({ ...validMetrics(), queryTargeting: -0.1 }))
      .toThrow()
  })
})

// ── 3. clampMetrics ───────────────────────────────────────────────

describe('clampMetrics', () => {
  it('음수 connections를 0으로 보정한다', () => {
    const r = clampMetrics({ ...validMetrics(), connections: -50 })
    expect(r.connections).toBe(0)
  })

  it('connections를 정수로 반올림한다', () => {
    const r = clampMetrics({ ...validMetrics(), connections: 123.7 })
    expect(r.connections).toBe(124)
  })

  it('cpuNormalizedPct > 100을 100으로 클램프한다', () => {
    const r = clampMetrics({ ...validMetrics(), cpuNormalizedPct: 150 })
    expect(r.cpuNormalizedPct).toBe(100)
  })

  it('memoryUsedPct > 100을 100으로 클램프한다', () => {
    const r = clampMetrics({ ...validMetrics(), memoryUsedPct: 999 })
    expect(r.memoryUsedPct).toBe(100)
  })

  it('음수 diskQueueDepth를 0으로 보정한다', () => {
    const r = clampMetrics({ ...validMetrics(), diskQueueDepth: -2.5 })
    expect(r.diskQueueDepth).toBe(0)
  })

  it('NaN을 0으로 보정한다', () => {
    const r = clampMetrics({ ...validMetrics(), cpuNormalizedPct: NaN })
    expect(r.cpuNormalizedPct).toBe(0)
  })

  it('Infinity를 0으로 보정한다', () => {
    const r = clampMetrics({ ...validMetrics(), readLatencyMs: Infinity })
    expect(r.readLatencyMs).toBe(0)
  })

  it('클램핑 후 결과가 Zod 스키마를 통과한다', () => {
    const badMetrics: NormalizedMetrics = {
      connections: -10, cpuNormalizedPct: 200, memoryUsedPct: -5,
      diskUsedGb: -1, diskQueueDepth: NaN, readLatencyMs: Infinity,
      writeLatencyMs: -3, queryTargeting: -100,
    }
    const clamped = clampMetrics(badMetrics)
    expect(() => NormalizedMetricsSchema.parse(clamped)).not.toThrow()
  })

  it('정상 값은 변경 없이 그대로 반환한다', () => {
    const good = validMetrics()
    const r    = clampMetrics(good)
    expect(r.cpuNormalizedPct).toBeCloseTo(good.cpuNormalizedPct, 1)
    expect(r.memoryUsedPct).toBeCloseTo(good.memoryUsedPct, 1)
  })
})

// ── 4. MockMetricsAdapter 시나리오 ────────────────────────────────

describe('MockMetricsAdapter 시나리오', () => {
  const scenarios: MockScenario[] = [
    'normal', 'connection_surge', 'cpu_saturation',
    'storage_pressure', 'query_inefficiency',
  ]

  for (const scenario of scenarios) {
    it(`${scenario}: 기준값 ±15% 범위를 유지한다`, async () => {
      const adapter  = new MockMetricsAdapter({ scenario })
      const result   = await adapter.collect('test-cluster')
      const baseline = getScenarioBaseline(scenario)

      for (const key of Object.keys(baseline) as Array<keyof NormalizedMetrics>) {
        const base  = baseline[key]
        const value = result.metrics[key]
        if (base === 0) continue

        const ratio = value / base
        expect(ratio, `${scenario}.${key}: ${value} vs baseline ${base}`)
          .toBeGreaterThan(0.85)
        expect(ratio, `${scenario}.${key}: ${value} vs baseline ${base}`)
          .toBeLessThan(1.15)
      }
    })
  }

  it('connection_surge: connections가 800을 초과한다', async () => {
    const adapter = new MockMetricsAdapter({ scenario: 'connection_surge' })
    for (let i = 0; i < 5; i++) {
      const r = await adapter.collect('c')
      expect(r.metrics.connections).toBeGreaterThan(800)
    }
  })

  it('query_inefficiency: queryTargeting이 100을 초과한다', async () => {
    const adapter = new MockMetricsAdapter({ scenario: 'query_inefficiency' })
    for (let i = 0; i < 5; i++) {
      const r = await adapter.collect('c')
      expect(r.metrics.queryTargeting).toBeGreaterThan(100)
    }
  })

  it('cpu_saturation: cpuNormalizedPct가 70을 초과한다', async () => {
    const adapter = new MockMetricsAdapter({ scenario: 'cpu_saturation' })
    for (let i = 0; i < 5; i++) {
      const r = await adapter.collect('c')
      expect(r.metrics.cpuNormalizedPct).toBeGreaterThan(70)
    }
  })

  it('storage_pressure: diskQueueDepth가 3을 초과한다', async () => {
    const adapter = new MockMetricsAdapter({ scenario: 'storage_pressure' })
    for (let i = 0; i < 5; i++) {
      const r = await adapter.collect('c')
      expect(r.metrics.diskQueueDepth).toBeGreaterThan(3)
    }
  })

  it('setScenario()로 런타임 시나리오 전환이 동작한다', async () => {
    const adapter = new MockMetricsAdapter({ scenario: 'normal' })
    const r1 = await adapter.collect('c')

    adapter.setScenario('connection_surge')
    const r2 = await adapter.collect('c')
    expect(r2.metrics.connections).toBeGreaterThan(r1.metrics.connections)
  })

  it('source 필드에 시나리오 이름이 포함된다', async () => {
    const adapter = new MockMetricsAdapter({ scenario: 'cpu_saturation' })
    const r = await adapter.collect('c')
    expect(r.source).toBe('mock:cpu_saturation')
  })
})

// ── 5. collectAndPersist — 단위 테스트 (DB null) ─────────────────

describe('collectAndPersist — DB null 모드', () => {
  it('DB가 null이면 insert 없이 metrics를 반환한다', async () => {
    const adapter = new MockMetricsAdapter({ scenario: 'normal' })
    const result  = await collectAndPersist({
      adapter,
      db:          null,
      clusterName: 'no-db-cluster',
      prom:        makeNoopMetrics(),
      skipGauges:  true,
    })

    expect(result.inserted).toBe(false)
    expect(result.metrics).toBeDefined()
    expect(result.metrics.connections).toBeGreaterThanOrEqual(0)
  })

  it('결과의 metrics가 클램핑되어 있다 — 어댑터 버그 시나리오', async () => {
    const badAdapter = {
      name:        'bad-mock',
      isAvailable: async () => true,
      collect:     async (_: string) => ({
        clusterName:  'x',
        projectId:    'p',
        source:       'bad',
        timestamp:    new Date(),
        metrics: {
          connections: -50, cpuNormalizedPct: 200, memoryUsedPct: -10,
          diskUsedGb: -5, diskQueueDepth: NaN, readLatencyMs: Infinity,
          writeLatencyMs: -1, queryTargeting: -100,
        },
      }),
    }

    const result = await collectAndPersist({
      adapter:     badAdapter,
      db:          null,
      clusterName: 'x',
      prom:        makeNoopMetrics(),
      skipGauges:  true,
    })

    const m = result.metrics
    expect(m.connections).toBe(0)
    expect(m.cpuNormalizedPct).toBe(100)
    expect(m.memoryUsedPct).toBe(0)
    expect(m.diskUsedGb).toBe(0)
    expect(m.diskQueueDepth).toBe(0)
    expect(m.readLatencyMs).toBe(0)
    expect(m.writeLatencyMs).toBe(0)
    expect(m.queryTargeting).toBe(0)
  })
})

// ── 6. collectAndPersist — 통합 테스트 (MongoDB) ─────────────────

describe('collectAndPersist — MongoDB 통합', () => {
  it('클램핑된 메트릭을 atlas_metrics_ts 에 insert한다', async () => {
    const before  = await queryRecentMetrics(db, 'int-cluster', 1)
    const adapter = new MockMetricsAdapter({ scenario: 'normal' })

    const result = await collectAndPersist({
      adapter,
      db,
      clusterName: 'int-cluster',
      prom:        makeNoopMetrics(),
      skipGauges:  true,
    })

    expect(result.inserted).toBe(true)
    const after = await queryRecentMetrics(db, 'int-cluster', 1)
    expect(after.length).toBe(before.length + 1)
  })

  it('저장된 문서에 8개 필드가 모두 있다', async () => {
    const adapter = new MockMetricsAdapter({ scenario: 'connection_surge' })
    await collectAndPersist({
      adapter,
      db,
      clusterName: 'field-check',
      prom:        makeNoopMetrics(),
      skipGauges:  true,
    })

    const docs = await queryRecentMetrics(db, 'field-check', 1)
    expect(docs.length).toBeGreaterThan(0)

    const stored = docs[0].metrics
    for (const field of NORMALIZED_METRIC_FIELDS) {
      expect(stored[field], `stored.${field} should be defined`).toBeDefined()
      expect(typeof stored[field]).toBe('number')
    }
  })

  it('각 시나리오의 메트릭이 올바른 클러스터에 저장된다', async () => {
    const scenarios: MockScenario[] = ['normal', 'cpu_saturation', 'storage_pressure']

    for (const scenario of scenarios) {
      const adapter = new MockMetricsAdapter({ scenario })
      await collectAndPersist({
        adapter,
        db,
        clusterName: `scenario-${scenario}`,
        prom:        makeNoopMetrics(),
        skipGauges:  true,
      })
    }

    for (const scenario of scenarios) {
      const docs = await queryRecentMetrics(db, `scenario-${scenario}`, 1)
      expect(docs.length).toBeGreaterThan(0)
      expect(docs[0].meta.clusterName).toBe(`scenario-${scenario}`)
    }
  })
})

// ── 7. 오류 처리 ──────────────────────────────────────────────────

describe('collectAndPersist — 오류 처리', () => {
  it('어댑터 오류가 상위로 전파된다', async () => {
    const failAdapter = {
      name: 'fail', isAvailable: async () => false,
      collect: async () => { throw new Error('adapter failure') },
    }

    await expect(
      collectAndPersist({
        adapter:    failAdapter,
        db:         null,
        clusterName:'fail-cluster',
        prom:       makeNoopMetrics(),
        skipGauges: true,
      }),
    ).rejects.toThrow('adapter failure')
  })
})

// ── 8. normalizeAtlasResponse ────────────────────────────────────

describe('normalizeAtlasResponse', () => {
  it('8개 Atlas 측정값 이름을 올바르게 매핑한다', () => {
    const raw: AtlasRawMeasurement[] = [
      { name: 'CONNECTIONS',                               units: 'SCALAR',    dataPoints: [{ timestamp: 't', value: 500    }] },
      { name: 'NORMALIZED_SYSTEM_CPU',                     units: 'PERCENT',   dataPoints: [{ timestamp: 't', value: 42.5   }] },
      { name: 'MEMORY_RESIDENT',                           units: 'MEGABYTES', dataPoints: [{ timestamp: 't', value: 60     }] },
      { name: 'DISK_QUEUE_DEPTH',                          units: 'SCALAR',    dataPoints: [{ timestamp: 't', value: 2.3    }] },
      { name: 'DISK_SPACE_USED_DATA',                      units: 'BYTES',     dataPoints: [{ timestamp: 't', value: 150    }] },
      { name: 'OP_EXECUTION_TIME_READS',                   units: 'MILLISECONDS', dataPoints: [{ timestamp: 't', value: 12  }] },
      { name: 'OP_EXECUTION_TIME_WRITES',                  units: 'MILLISECONDS', dataPoints: [{ timestamp: 't', value: 18  }] },
      { name: 'QUERY_TARGETING_SCANNED_OBJECTS_PER_RETURNED', units: 'SCALAR', dataPoints: [{ timestamp: 't', value: 25    }] },
    ]

    const metrics = normalizeAtlasResponse(raw)
    expect(metrics.connections).toBe(500)
    expect(metrics.cpuNormalizedPct).toBe(42.5)
    expect(metrics.memoryUsedPct).toBe(60)
    expect(metrics.diskQueueDepth).toBe(2.3)
    expect(metrics.diskUsedGb).toBe(150)
    expect(metrics.readLatencyMs).toBe(12)
    expect(metrics.writeLatencyMs).toBe(18)
    expect(metrics.queryTargeting).toBe(25)
  })

  it('마지막 non-null 데이터포인트를 사용한다', () => {
    const raw: AtlasRawMeasurement[] = [{
      name: 'CONNECTIONS', units: 'SCALAR',
      dataPoints: [
        { timestamp: 't1', value: 100 },
        { timestamp: 't2', value: null },
        { timestamp: 't3', value: 800 },
        { timestamp: 't4', value: null },
      ],
    }]
    expect(normalizeAtlasResponse(raw).connections).toBe(800)
  })

  it('매핑되지 않은 측정값은 무시한다', () => {
    const raw: AtlasRawMeasurement[] = [
      { name: 'UNKNOWN_METRIC', units: 'SCALAR', dataPoints: [{ timestamp: 't', value: 9999 }] },
    ]
    const metrics = normalizeAtlasResponse(raw)
    expect(metrics.connections).toBe(0)
  })

  it('비어있는 dataPoints는 0으로 처리한다', () => {
    const raw: AtlasRawMeasurement[] = [
      { name: 'CONNECTIONS', units: 'SCALAR', dataPoints: [] },
    ]
    expect(normalizeAtlasResponse(raw).connections).toBe(0)
  })
})

// ── 헬퍼 ─────────────────────────────────────────────────────────

function validMetrics(): NormalizedMetrics {
  return {
    connections: 300, cpuNormalizedPct: 40, memoryUsedPct: 55,
    diskUsedGb: 120, diskQueueDepth: 1.2, readLatencyMs: 8,
    writeLatencyMs: 12, queryTargeting: 20,
  }
}

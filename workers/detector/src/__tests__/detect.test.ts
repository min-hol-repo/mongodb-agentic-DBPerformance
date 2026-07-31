/**
 * Detector Worker 통합 테스트
 *
 * 범위:
 *   1. 데이터 없을 때 조기 종료
 *   2. 룰 트리거 → 신규 이벤트 생성 (4가지 병목 유형)
 *   3. 중복 억제 — 동일 조건 재실행 시 이벤트 중복 없음
 *   4. 에스컬레이션 — severity 상승 시 기존 이벤트 갱신
 *   5. Auto-resolution — 룰 해소 시 이벤트 resolved
 *   6. 복수 룰 동시 트리거
 *   7. db=null 모드 (평가만, 저장 없음)
 *   8. query_inefficiency → 타 룰 consider_scale_up 제거
 */

import { MongoClient } from 'mongodb'
import type { Db } from 'mongodb'
import { MongoMemoryServer } from 'mongodb-memory-server'
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import {
  RuleEngine,
  ConnectionPressureRule,
  CpuSaturationRule,
  StorageBottleneckRule,
  QueryInefficiencyRule,
} from '@demo/rules'
import {
  ensureCollections,
  findRecentEvents,
  findOpenEventByType,
  _injectDb,
  _resetDb,
  type NormalizedMetrics,
} from '@demo/shared'
import { detectAndPersist } from '../detect.js'
import { makeNoopMetrics } from '../metrics.js'

// ── 셋업 ─────────────────────────────────────────────────────────

let mongod: MongoMemoryServer
let mongoClient: MongoClient
let db: Db

const engine = new RuleEngine([
  new ConnectionPressureRule(),
  new CpuSaturationRule(),
  new StorageBottleneckRule(),
  new QueryInefficiencyRule(),
])

beforeAll(async () => {
  mongod      = await MongoMemoryServer.create()
  mongoClient = new MongoClient(mongod.getUri())
  await mongoClient.connect()
  db = mongoClient.db('detector_test')
  await ensureCollections(db)
  _injectDb(mongoClient, db)
})

afterAll(async () => {
  _resetDb()
  await mongoClient.close()
  await mongod.stop()
})

afterEach(async () => {
  await db.collection('bottleneck_events').deleteMany({})
})

// ── 픽스처 ────────────────────────────────────────────────────────

function normal(): NormalizedMetrics {
  return {
    connections: 250, cpuNormalizedPct: 25, memoryUsedPct: 45,
    diskUsedGb: 120, diskQueueDepth: 0.8, readLatencyMs: 6,
    writeLatencyMs: 9, queryTargeting: 15,
  }
}

function withConnSurge(): NormalizedMetrics {
  return { ...normal(), connections: 950, readLatencyMs: 5 }
}

function withCpuHigh(): NormalizedMetrics {
  return { ...normal(), cpuNormalizedPct: 80 }
}

function withDiskPressure(): NormalizedMetrics {
  return { ...normal(), diskQueueDepth: 5.0 }
}

function withQueryInefficiency(): NormalizedMetrics {
  return { ...normal(), queryTargeting: 200 }
}

function pts(override: NormalizedMetrics, count = 5): NormalizedMetrics[] {
  return Array.from({ length: count }, () => ({ ...override }))
}

// ── 1. 데이터 없을 때 조기 종료 ──────────────────────────────────

describe('조기 종료', () => {
  it('injectedPoints 없고 DB 비어있으면 결과 없음', async () => {
    const res = await detectAndPersist({
      db, clusterName: 'empty', engine,
      windowMinutes: 5, prom: makeNoopMetrics(),
      minDataPoints: 1,
    })
    expect(res.results).toHaveLength(0)
    expect(res.pointsFound).toBe(0)
  })

  it('injectedPoints = [] → minDataPoints=1 이면 조기 종료', async () => {
    const res = await detectAndPersist({
      db, clusterName: 'empty', engine,
      windowMinutes: 5, prom: makeNoopMetrics(),
      minDataPoints: 1, injectedPoints: [],
    })
    expect(res.results).toHaveLength(0)
    expect(res.eventsCreated).toBe(0)
  })
})

// ── 2. 신규 이벤트 생성 (4가지 병목 유형) ────────────────────────

describe('신규 이벤트 생성', () => {
  it('connection_pressure: 이벤트 생성', async () => {
    const res = await detectAndPersist({
      db, clusterName: 'conn-test', engine,
      windowMinutes: 5, prom: makeNoopMetrics(),
      injectedPoints: pts(withConnSurge()),
    })

    expect(res.eventsCreated).toBe(1)
    const events = await findRecentEvents(db, 'conn-test')
    expect(events).toHaveLength(1)
    expect(events[0].type).toBe('connection_pressure')
    expect(events[0].status).toBe('open')
  })

  it('cpu_saturation: 이벤트 생성', async () => {
    const res = await detectAndPersist({
      db, clusterName: 'cpu-test', engine,
      windowMinutes: 5, prom: makeNoopMetrics(),
      injectedPoints: pts(withCpuHigh()),
    })

    expect(res.eventsCreated).toBe(1)
    const events = await findRecentEvents(db, 'cpu-test')
    expect(events[0].type).toBe('cpu_saturation')
    expect(events[0].ruleId).toBe('RULE_CPU_001')
  })

  it('storage_bottleneck: 이벤트 생성', async () => {
    const res = await detectAndPersist({
      db, clusterName: 'disk-test', engine,
      windowMinutes: 5, prom: makeNoopMetrics(),
      injectedPoints: pts(withDiskPressure(), 2),
    })

    expect(res.eventsCreated).toBe(1)
    const events = await findRecentEvents(db, 'disk-test')
    expect(events[0].type).toBe('storage_bottleneck')
    expect(events[0].severity).toBe('high')
  })

  it('query_inefficiency: 이벤트 생성', async () => {
    const res = await detectAndPersist({
      db, clusterName: 'query-test', engine,
      windowMinutes: 5, prom: makeNoopMetrics(),
      injectedPoints: pts(withQueryInefficiency()),
    })

    expect(res.eventsCreated).toBe(1)
    const events = await findRecentEvents(db, 'query-test')
    expect(events[0].type).toBe('query_inefficiency')
    expect(events[0].recommendedActions).toContain('review_indexes')
  })

  it('생성된 이벤트에 signals 포함', async () => {
    await detectAndPersist({
      db, clusterName: 'sig-test', engine,
      windowMinutes: 5, prom: makeNoopMetrics(),
      injectedPoints: pts(withConnSurge()),
    })

    const events = await findRecentEvents(db, 'sig-test')
    expect(events[0].signals).toBeDefined()
    expect(events[0].signals!.avgConnections).toBeGreaterThan(0)
  })
})

// ── 3. 중복 억제 ──────────────────────────────────────────────────

describe('중복 억제 (duplicate suppression)', () => {
  it('동일 조건 2회 실행 → 이벤트 1개만 존재', async () => {
    const opts = {
      db, clusterName: 'dup-test', engine,
      windowMinutes: 5, prom: makeNoopMetrics(),
      injectedPoints: pts(withConnSurge()),
    }
    const r1 = await detectAndPersist(opts)
    const r2 = await detectAndPersist(opts)

    expect(r1.eventsCreated).toBe(1)
    expect(r2.eventsSuppressed).toBe(1)
    expect(r2.eventsCreated).toBe(0)

    const events = await findRecentEvents(db, 'dup-test')
    expect(events).toHaveLength(1)
  })

  it('다른 타입은 각각 별도 이벤트 생성', async () => {
    await detectAndPersist({
      db, clusterName: 'multi-type', engine,
      windowMinutes: 5, prom: makeNoopMetrics(),
      injectedPoints: pts(withConnSurge()),
    })
    await detectAndPersist({
      db, clusterName: 'multi-type', engine,
      windowMinutes: 5, prom: makeNoopMetrics(),
      injectedPoints: pts(withCpuHigh()),
    })

    const events = await findRecentEvents(db, 'multi-type')
    const types = events.map(e => e.type)
    expect(types).toContain('connection_pressure')
    expect(types).toContain('cpu_saturation')
    expect(events).toHaveLength(2)
  })
})

// ── 4. 에스컬레이션 ───────────────────────────────────────────────

describe('에스컬레이션 (severity escalation)', () => {
  it('severity 상승 시 기존 이벤트 갱신 (새 이벤트 추가 안 함)', async () => {
    // 1차: medium (connections 950, low latency)
    await detectAndPersist({
      db, clusterName: 'esc-test', engine,
      windowMinutes: 5, prom: makeNoopMetrics(),
      injectedPoints: pts({ ...withConnSurge(), readLatencyMs: 5 }),
    })

    // 2차: high (connections 1300)
    const r2 = await detectAndPersist({
      db, clusterName: 'esc-test', engine,
      windowMinutes: 5, prom: makeNoopMetrics(),
      injectedPoints: pts({ ...normal(), connections: 1300 }),
    })

    expect(r2.eventsEscalated).toBe(1)
    expect(r2.eventsCreated).toBe(0)

    // DB에 이벤트 1개, severity = high
    const events = await findRecentEvents(db, 'esc-test')
    const connEvent = events.find(e => e.type === 'connection_pressure')
    expect(connEvent!.severity).toBe('high')
  })

  it('severity 동일 시 에스컬레이션 없음 (suppressed)', async () => {
    await detectAndPersist({
      db, clusterName: 'esc-same', engine,
      windowMinutes: 5, prom: makeNoopMetrics(),
      injectedPoints: pts({ ...normal(), connections: 1300 }),
    })
    const r2 = await detectAndPersist({
      db, clusterName: 'esc-same', engine,
      windowMinutes: 5, prom: makeNoopMetrics(),
      injectedPoints: pts({ ...normal(), connections: 1300 }),
    })

    expect(r2.eventsEscalated).toBe(0)
    expect(r2.eventsSuppressed).toBe(1)
  })
})

// ── 5. Auto-resolution ────────────────────────────────────────────

describe('Auto-resolution', () => {
  it('룰 해소 시 open 이벤트를 resolved로 업데이트', async () => {
    // 1차: 이벤트 생성
    await detectAndPersist({
      db, clusterName: 'res-test', engine,
      windowMinutes: 5, prom: makeNoopMetrics(),
      injectedPoints: pts(withConnSurge()),
    })

    // 2차: 정상 → 이벤트 해소
    const r2 = await detectAndPersist({
      db, clusterName: 'res-test', engine,
      windowMinutes: 5, prom: makeNoopMetrics(),
      injectedPoints: pts(normal()),
    })

    expect(r2.eventsResolved).toBe(1)

    const open = await findOpenEventByType(db, 'res-test', 'connection_pressure')
    expect(open).toBeNull()
  })

  it('open 이벤트 없는 타입은 resolution 시도 안 함', async () => {
    const r = await detectAndPersist({
      db, clusterName: 'res-none', engine,
      windowMinutes: 5, prom: makeNoopMetrics(),
      injectedPoints: pts(normal()),
    })
    expect(r.eventsResolved).toBe(0)
  })
})

// ── 6. 복수 룰 동시 트리거 ────────────────────────────────────────

describe('복수 룰 동시 트리거', () => {
  it('4개 룰 모두 트리거 시 4개 이벤트 생성', async () => {
    const allBad: NormalizedMetrics = {
      connections: 950, cpuNormalizedPct: 80,
      diskQueueDepth: 5.0, queryTargeting: 200,
      memoryUsedPct: 60, diskUsedGb: 140,
      readLatencyMs: 10, writeLatencyMs: 15,
    }
    const res = await detectAndPersist({
      db, clusterName: 'all-bad', engine,
      windowMinutes: 5, prom: makeNoopMetrics(),
      injectedPoints: pts(allBad),
    })

    expect(res.eventsCreated).toBe(4)
    const events = await findRecentEvents(db, 'all-bad')
    expect(events).toHaveLength(4)

    const types = events.map(e => e.type)
    expect(types).toContain('connection_pressure')
    expect(types).toContain('cpu_saturation')
    expect(types).toContain('storage_bottleneck')
    expect(types).toContain('query_inefficiency')
  })

  it('결과에 pointsFound 포함', async () => {
    const res = await detectAndPersist({
      db, clusterName: 'pf-test', engine,
      windowMinutes: 5, prom: makeNoopMetrics(),
      injectedPoints: pts(withConnSurge()),
    })
    expect(res.pointsFound).toBe(5)
  })
})

// ── 7. db=null 모드 ───────────────────────────────────────────────

describe('db=null 모드 (평가만)', () => {
  it('db=null이면 룰 평가 결과 반환하지만 이벤트 저장 안 함', async () => {
    const res = await detectAndPersist({
      db: null, clusterName: 'null-db', engine,
      windowMinutes: 5, prom: makeNoopMetrics(),
      injectedPoints: pts(withConnSurge()),
    })

    expect(res.results.length).toBeGreaterThan(0)
    expect(res.eventsCreated).toBe(0)
    expect(res.eventsResolved).toBe(0)
  })

  it('db=null + injectedPoints 없음 → points=0, 결과 없음', async () => {
    const res = await detectAndPersist({
      db: null, clusterName: 'null-empty', engine,
      windowMinutes: 5, prom: makeNoopMetrics(),
    })
    expect(res.pointsFound).toBe(0)
    expect(res.results).toHaveLength(0)
  })
})

// ── 8. query_inefficiency 우선순위 ────────────────────────────────

describe('query_inefficiency 교차 룰 우선순위', () => {
  it('query_inefficiency + connection_pressure 동시 → conn의 consider_scale_up 제거', async () => {
    const mixed: NormalizedMetrics = {
      ...normal(), connections: 950, queryTargeting: 200,
    }
    const res = await detectAndPersist({
      db: null, clusterName: 'priority', engine,
      windowMinutes: 5, prom: makeNoopMetrics(),
      injectedPoints: pts(mixed),
    })

    const connResult = res.results.find(r => r.type === 'connection_pressure')
    expect(connResult).toBeDefined()
    expect(connResult!.recommendedActions).not.toContain('consider_scale_up')
  })
})

// ── 9. bottleneck_events 저장 필드 완전성 검증 ───────────────────

describe('bottleneck_events 저장 필드 검증', () => {
  const REQUIRED_FIELDS = [
    'timestamp', 'clusterName', 'severity', 'type',
    'ruleId', 'summary', 'recommendedActions', 'status',
  ] as const

  it('저장된 이벤트에 필수 필드가 모두 있다', async () => {
    await detectAndPersist({
      db, clusterName: 'field-test', engine,
      windowMinutes: 5, prom: makeNoopMetrics(),
      injectedPoints: pts({ ...normal(), connections: 1300 }),   // high severity
    })

    const events = await findRecentEvents(db, 'field-test')
    expect(events.length).toBeGreaterThan(0)

    const ev = events[0]
    for (const field of REQUIRED_FIELDS) {
      expect(ev, `field '${field}' missing`).toHaveProperty(field)
      expect(ev[field], `field '${field}' should not be null/undefined`).toBeDefined()
    }
  })

  it('timestamp 필드가 Date 타입이다', async () => {
    await detectAndPersist({
      db, clusterName: 'ts-test', engine,
      windowMinutes: 5, prom: makeNoopMetrics(),
      injectedPoints: pts({ ...normal(), connections: 1300 }),
    })

    const events = await findRecentEvents(db, 'ts-test')
    expect(events[0].timestamp).toBeInstanceOf(Date)
  })

  it('clusterName 필드가 요청한 클러스터와 일치한다', async () => {
    await detectAndPersist({
      db, clusterName: 'cluster-name-test', engine,
      windowMinutes: 5, prom: makeNoopMetrics(),
      injectedPoints: pts({ ...normal(), connections: 1300 }),
    })

    const events = await findRecentEvents(db, 'cluster-name-test')
    expect(events[0].clusterName).toBe('cluster-name-test')
  })

  it('severity 필드가 low | medium | high 중 하나다', async () => {
    await detectAndPersist({
      db, clusterName: 'sev-test', engine,
      windowMinutes: 5, prom: makeNoopMetrics(),
      injectedPoints: pts({ ...normal(), connections: 1300 }),
    })

    const events = await findRecentEvents(db, 'sev-test')
    expect(['low', 'medium', 'high']).toContain(events[0].severity)
  })

  it('type 필드가 4가지 병목 유형 중 하나다', async () => {
    const VALID_TYPES = ['connection_pressure', 'cpu_saturation', 'storage_bottleneck', 'query_inefficiency']

    await detectAndPersist({
      db, clusterName: 'type-test', engine,
      windowMinutes: 5, prom: makeNoopMetrics(),
      injectedPoints: pts({ ...normal(), connections: 1300 }),
    })

    const events = await findRecentEvents(db, 'type-test')
    expect(VALID_TYPES).toContain(events[0].type)
  })

  it('ruleId 필드가 RULE_ 접두사를 갖는다', async () => {
    await detectAndPersist({
      db, clusterName: 'ruleid-test', engine,
      windowMinutes: 5, prom: makeNoopMetrics(),
      injectedPoints: pts({ ...normal(), connections: 1300 }),
    })

    const events = await findRecentEvents(db, 'ruleid-test')
    expect(events[0].ruleId).toMatch(/^RULE_/)
  })

  it('summary 필드가 비어있지 않은 문자열이다', async () => {
    await detectAndPersist({
      db, clusterName: 'sum-test', engine,
      windowMinutes: 5, prom: makeNoopMetrics(),
      injectedPoints: pts({ ...normal(), connections: 1300 }),
    })

    const events = await findRecentEvents(db, 'sum-test')
    expect(typeof events[0].summary).toBe('string')
    expect(events[0].summary.length).toBeGreaterThan(0)
  })

  it('recommendedActions 필드가 비어있지 않은 배열이다', async () => {
    await detectAndPersist({
      db, clusterName: 'ra-test', engine,
      windowMinutes: 5, prom: makeNoopMetrics(),
      injectedPoints: pts({ ...normal(), connections: 1300 }),
    })

    const events = await findRecentEvents(db, 'ra-test')
    expect(Array.isArray(events[0].recommendedActions)).toBe(true)
    expect(events[0].recommendedActions.length).toBeGreaterThan(0)
  })

  it('status 필드가 open | resolved | suppressed 중 하나다', async () => {
    await detectAndPersist({
      db, clusterName: 'status-test', engine,
      windowMinutes: 5, prom: makeNoopMetrics(),
      injectedPoints: pts({ ...normal(), connections: 1300 }),
    })

    const events = await findRecentEvents(db, 'status-test')
    expect(['open', 'resolved', 'suppressed']).toContain(events[0].status)
  })

  it('신규 이벤트는 status = open 으로 저장된다', async () => {
    await detectAndPersist({
      db, clusterName: 'open-test', engine,
      windowMinutes: 5, prom: makeNoopMetrics(),
      injectedPoints: pts({ ...normal(), connections: 1300 }),
    })

    const events = await findRecentEvents(db, 'open-test')
    expect(events[0].status).toBe('open')
  })

  it('4가지 병목 유형이 각각 올바른 ruleId로 저장된다', async () => {
    const allBad: NormalizedMetrics = {
      connections: 1300, cpuNormalizedPct: 80,
      diskQueueDepth: 5.0, queryTargeting: 200,
      memoryUsedPct: 60, diskUsedGb: 140,
      readLatencyMs: 10, writeLatencyMs: 15,
    }

    await detectAndPersist({
      db, clusterName: 'ruleid-all', engine,
      windowMinutes: 5, prom: makeNoopMetrics(),
      injectedPoints: pts(allBad),
    })

    const events = await findRecentEvents(db, 'ruleid-all', 10)
    const ruleMap: Record<string, string> = {
      connection_pressure:  'RULE_CONN_001',
      cpu_saturation:       'RULE_CPU_001',
      storage_bottleneck:   'RULE_DISK_001',
      query_inefficiency:   'RULE_QUERY_001',
    }

    for (const [type, expectedRuleId] of Object.entries(ruleMap)) {
      const ev = events.find(e => e.type === type)
      expect(ev, `event for type '${type}' missing`).toBeDefined()
      expect(ev!.ruleId).toBe(expectedRuleId)
    }
  })
})

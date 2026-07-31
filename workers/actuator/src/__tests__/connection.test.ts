/**
 * Detector → Actuator 연결 규칙 통합 테스트
 *
 * 이 테스트는 다음을 검증한다:
 *   1. query_inefficiency 감지 → notify_only 액션만 생성 (scale 절대 금지)
 *   2. connection_pressure 감지 → 보수적 scale 제안 (not auto-executed)
 *   3. cpu_saturation 감지 → scale 권고 (not auto-executed)
 *   4. storage_bottleneck 감지 → scale 요청 (not auto-executed)
 *   5. 복수 이벤트 동시 감지 → 올바른 액션 타입 매핑
 *   6. 어떤 액션도 자동 실행되지 않음 (result = not_executed | pending)
 *   7. BOTTLENECK_ACTION_MAP 테이블의 완전성
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
  insertEvent,
  findRecentActions,
  _injectDb,
  _resetDb,
  type EventWithId,
  type ActuatorPolicy,
} from '@demo/shared'
import { evaluateAndPersist, BOTTLENECK_ACTION_MAP } from '../policy.js'
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
  db = mongoClient.db('connection_test')
  await ensureCollections(db)
  _injectDb(mongoClient, db)
})

afterAll(async () => {
  _resetDb()
  await mongoClient.close()
  await mongod.stop()
})

afterEach(async () => {
  await db.collection('actuator_actions').deleteMany({})
  await db.collection('actuator_policies').deleteMany({})
  await db.collection('bottleneck_events').deleteMany({})
})

// ── 픽스처 ────────────────────────────────────────────────────────

function makeEvent(overrides: Partial<EventWithId> = {}): EventWithId {
  return {
    _id:               'evt-001',
    timestamp:         new Date().toISOString(),
    projectId:         'test-project',
    clusterName:       'test-cluster',
    severity:          'high',
    type:              'connection_pressure',
    ruleId:            'RULE_CONN_001',
    summary:           '연결 수 초과',
    recommendedActions: ['check_connection_pooling'],
    status:            'open',
    signals:           {},
    ...overrides,
  } as EventWithId
}

function makePolicy(overrides: Partial<ActuatorPolicy> = {}): ActuatorPolicy {
  return {
    clusterName:     'test-cluster',
    mode:            'dry_run',
    maxTier:         'M60',
    cooldownMinutes: 0,   // 테스트에서 cooldown 무시
    allowActions:    ['scale_recommendation', 'scale_up_request', 'notify_only'],
    blockedActions:  [],
    updatedAt:       new Date(),
    ...overrides,
  }
}

// ── 1. query_inefficiency → notify_only (추천 전용) ────────────────

describe('규칙 1: query_inefficiency → 추천 전용 (notify_only)', () => {
  it('low severity → notify_only', async () => {
    await evaluateAndPersist({
      db, prom: makeNoopMetrics(),
      injectedPolicy: makePolicy(),
      openEvents: [makeEvent({ type: 'query_inefficiency', severity: 'low', ruleId: 'RULE_QUERY_001' })],
    })
    const actions = await findRecentActions(db, 'test-cluster')
    expect(actions[0].actionType).toBe('notify_only')
  })

  it('medium severity → notify_only', async () => {
    await evaluateAndPersist({
      db, prom: makeNoopMetrics(),
      injectedPolicy: makePolicy(),
      openEvents: [makeEvent({ type: 'query_inefficiency', severity: 'medium', ruleId: 'RULE_QUERY_001' })],
    })
    const actions = await findRecentActions(db, 'test-cluster')
    expect(actions[0].actionType).toBe('notify_only')
  })

  it('high severity → notify_only (scale 절대 금지)', async () => {
    await evaluateAndPersist({
      db, prom: makeNoopMetrics(),
      injectedPolicy: makePolicy(),
      openEvents: [makeEvent({ type: 'query_inefficiency', severity: 'high', ruleId: 'RULE_QUERY_001' })],
    })
    const actions = await findRecentActions(db, 'test-cluster')
    expect(actions[0].actionType).toBe('notify_only')
    expect(actions[0].actionType).not.toBe('scale_up_request')
    expect(actions[0].actionType).not.toBe('scale_recommendation')
  })

  it('query_inefficiency는 scale 관련 actionType을 절대 생성하지 않는다 (10회 반복)', async () => {
    for (let i = 0; i < 10; i++) {
      await db.collection('actuator_actions').deleteMany({})
      await evaluateAndPersist({
        db, prom: makeNoopMetrics(),
        injectedPolicy: makePolicy(),
        openEvents: [makeEvent({
          _id: `evt-${i}`,
          type: 'query_inefficiency',
          severity: (['low', 'medium', 'high'] as const)[i % 3],
          ruleId: 'RULE_QUERY_001',
        } as Partial<EventWithId>)],
      })
      const actions = await findRecentActions(db, 'test-cluster')
      for (const a of actions) {
        expect(['scale_recommendation', 'scale_up_request']).not.toContain(a.actionType)
      }
    }
  })
})

// ── 2. connection_pressure → 보수적 scale 제안 ───────────────────

describe('규칙 2: connection_pressure → 보수적 scale 제안', () => {
  it('low severity → scale_recommendation (권고만, 자동 실행 없음)', async () => {
    await evaluateAndPersist({
      db, prom: makeNoopMetrics(),
      injectedPolicy: makePolicy(),
      openEvents: [makeEvent({ severity: 'low' })],
    })
    const actions = await findRecentActions(db, 'test-cluster')
    expect(actions[0].actionType).toBe('scale_recommendation')
    expect(actions[0].result).toBe('not_executed')   // 자동 실행 없음
  })

  it('medium severity → scale_recommendation', async () => {
    await evaluateAndPersist({
      db, prom: makeNoopMetrics(),
      injectedPolicy: makePolicy(),
      openEvents: [makeEvent({ severity: 'medium' })],
    })
    const actions = await findRecentActions(db, 'test-cluster')
    expect(actions[0].actionType).toBe('scale_recommendation')
  })

  it('high severity → scale_up_request (요청, 자동 실행 없음)', async () => {
    await evaluateAndPersist({
      db, prom: makeNoopMetrics(),
      injectedPolicy: makePolicy(),
      openEvents: [makeEvent({ severity: 'high' })],
    })
    const actions = await findRecentActions(db, 'test-cluster')
    expect(actions[0].actionType).toBe('scale_up_request')
    expect(actions[0].result).toBe('not_executed')   // 자동 실행 없음
  })
})

// ── 3. 자동 실행 없음 — 모든 모드에서 ─────────────────────────────

describe('규칙 3: 어떤 조치도 자동으로 실행되어서는 안 됨', () => {
  const AUTO_EXECUTED_STATUSES = ['executed']

  it('dry_run → result = not_executed', async () => {
    await evaluateAndPersist({
      db, prom: makeNoopMetrics(),
      injectedPolicy: makePolicy({ mode: 'dry_run' }),
      openEvents: [makeEvent()],
    })
    const actions = await findRecentActions(db, 'test-cluster')
    for (const a of actions) {
      expect(AUTO_EXECUTED_STATUSES).not.toContain(a.result)
      expect(a.result).toBe('not_executed')
    }
  })

  it('approval_required → result = pending (사람 승인 필요)', async () => {
    await evaluateAndPersist({
      db, prom: makeNoopMetrics(),
      injectedPolicy: makePolicy({ mode: 'approval_required' }),
      openEvents: [makeEvent()],
    })
    const actions = await findRecentActions(db, 'test-cluster')
    for (const a of actions) {
      expect(AUTO_EXECUTED_STATUSES).not.toContain(a.result)
      expect(a.result).toBe('pending')
    }
  })

  it('auto_execute → dry_run fallback (not_executed)', async () => {
    await evaluateAndPersist({
      db, prom: makeNoopMetrics(),
      injectedPolicy: makePolicy({ mode: 'auto_execute' }),
      openEvents: [makeEvent()],
    })
    const actions = await findRecentActions(db, 'test-cluster')
    for (const a of actions) {
      expect(AUTO_EXECUTED_STATUSES).not.toContain(a.result)
      expect(a.result).toBe('not_executed')
    }
  })

  it('모든 4가지 병목 유형 — 어떤 것도 자동 실행되지 않음', async () => {
    const events: EventWithId[] = [
      makeEvent({ _id: 'e1', type: 'connection_pressure',  ruleId: 'RULE_CONN_001',  severity: 'high' }),
      makeEvent({ _id: 'e2', type: 'cpu_saturation',       ruleId: 'RULE_CPU_001',   severity: 'high' }),
      makeEvent({ _id: 'e3', type: 'storage_bottleneck',   ruleId: 'RULE_DISK_001',  severity: 'high' }),
      makeEvent({ _id: 'e4', type: 'query_inefficiency',   ruleId: 'RULE_QUERY_001', severity: 'high' }),
    ] as EventWithId[]

    await evaluateAndPersist({
      db, prom: makeNoopMetrics(),
      injectedPolicy: makePolicy({ cooldownMinutes: 0 }),
      openEvents: events,
    })

    const actions = await findRecentActions(db, 'test-cluster', 10)
    for (const a of actions) {
      expect(a.result).not.toBe('executed')
    }
  })
})

// ── 4. 4가지 병목 유형 × BOTTLENECK_ACTION_MAP 완전성 ─────────────

describe('BOTTLENECK_ACTION_MAP 테이블 완전성 검증', () => {
  const BOTTLENECK_TYPES = [
    'connection_pressure', 'cpu_saturation', 'storage_bottleneck', 'query_inefficiency',
  ] as const

  const SEVERITIES = ['low', 'medium', 'high'] as const

  it('4가지 유형 × 3가지 severity 모두 정의되어 있다', () => {
    for (const type of BOTTLENECK_TYPES) {
      expect(BOTTLENECK_ACTION_MAP).toHaveProperty(type)
      for (const severity of SEVERITIES) {
        expect(BOTTLENECK_ACTION_MAP[type]).toHaveProperty(severity)
        const actionType = BOTTLENECK_ACTION_MAP[type][severity]
        expect(['scale_recommendation', 'scale_up_request', 'notify_only']).toContain(actionType)
      }
    }
  })

  it('query_inefficiency는 모든 severity에서 notify_only', () => {
    for (const severity of SEVERITIES) {
      expect(BOTTLENECK_ACTION_MAP.query_inefficiency[severity]).toBe('notify_only')
    }
  })

  it('connection_pressure low/medium은 scale_recommendation', () => {
    expect(BOTTLENECK_ACTION_MAP.connection_pressure.low).toBe('scale_recommendation')
    expect(BOTTLENECK_ACTION_MAP.connection_pressure.medium).toBe('scale_recommendation')
  })

  it('connection_pressure high는 scale_up_request', () => {
    expect(BOTTLENECK_ACTION_MAP.connection_pressure.high).toBe('scale_up_request')
  })

  it('storage_bottleneck은 항상 scale_up_request', () => {
    for (const severity of SEVERITIES) {
      expect(BOTTLENECK_ACTION_MAP.storage_bottleneck[severity]).toBe('scale_up_request')
    }
  })
})

// ── 5. 복수 이벤트 동시 처리 — 각 유형별 올바른 액션 ────────────

describe('복수 이벤트 → 유형별 올바른 액션 생성', () => {
  it('4가지 유형 동시 → 각각 올바른 actionType', async () => {
    // connection_pressure(high) = scale_up_request
    // storage_bottleneck(high)  = scale_up_request ← 동일 사이클 내 중복 skip
    // cpu_saturation(medium)    = scale_recommendation
    // query_inefficiency(high)  = notify_only
    // → 총 3개 생성, 1개 skip (scale_up_request 중복)
    const result = await evaluateAndPersist({
      db, prom: makeNoopMetrics(),
      injectedPolicy: makePolicy({ cooldownMinutes: 0 }),
      openEvents: [
        makeEvent({ _id: 'e1', type: 'connection_pressure', severity: 'high',   ruleId: 'RULE_CONN_001'  }),
        makeEvent({ _id: 'e2', type: 'cpu_saturation',      severity: 'medium', ruleId: 'RULE_CPU_001'   }),
        makeEvent({ _id: 'e3', type: 'storage_bottleneck',  severity: 'high',   ruleId: 'RULE_DISK_001'  }),
        makeEvent({ _id: 'e4', type: 'query_inefficiency',  severity: 'high',   ruleId: 'RULE_QUERY_001' }),
      ] as EventWithId[],
    })

    // connection_pressure + storage_bottleneck 둘 다 scale_up_request →
    // 첫 번째(conn)만 생성, 두 번째(disk)는 동일 사이클 중복 방지로 skip
    expect(result.actionsCreated).toBe(3)
    expect(result.actionsSkipped).toBe(1)
    expect(result.skipReasons[0].reason).toContain('pending_exists')

    const actions = await findRecentActions(db, 'test-cluster', 10)
    const actionTypes = actions.map(a => a.actionType)

    expect(actionTypes).toContain('scale_up_request')       // connection_pressure
    expect(actionTypes).toContain('scale_recommendation')   // cpu_saturation
    expect(actionTypes).toContain('notify_only')             // query_inefficiency
    // storage_bottleneck은 scale_up_request 중복으로 skip → 별도 액션 없음
    expect(actions.filter(a => a.actionType === 'scale_up_request')).toHaveLength(1)
  })

  it('동시 이벤트에서도 query_inefficiency는 scale 유발 안 함', async () => {
    await evaluateAndPersist({
      db, prom: makeNoopMetrics(),
      injectedPolicy: makePolicy({ cooldownMinutes: 0 }),
      openEvents: [
        makeEvent({ _id: 'e1', type: 'query_inefficiency',  severity: 'high', ruleId: 'RULE_QUERY_001' }),
        makeEvent({ _id: 'e2', type: 'connection_pressure', severity: 'high', ruleId: 'RULE_CONN_001'  }),
      ] as EventWithId[],
    })

    const actions = await findRecentActions(db, 'test-cluster', 10)
    const queryAction = actions.find(a => a.ruleId === 'RULE_QUERY_001')
    expect(queryAction?.actionType).toBe('notify_only')
  })
})

// ── 6. detector 결과 → actuator 입력 변환 흐름 ───────────────────

describe('detector 출력 → actuator 입력 연결 시뮬레이션', () => {
  it('detector가 저장한 open 이벤트를 actuator가 읽어 액션 생성', async () => {
    // detector가 저장한 것처럼 이벤트를 직접 DB에 삽입
    await insertEvent(db, {
      timestamp:          new Date(),
      projectId:          'test-project',
      clusterName:        'test-cluster',
      severity:           'high',
      type:               'connection_pressure',
      ruleId:             'RULE_CONN_001',
      summary:            'connections > 800',
      recommendedActions: ['check_connection_pooling'],
      status:             'open',
      signals:            { avgConnections: 950 },
    })

    // actuator가 open 이벤트를 읽어 처리 (실제 actuator/index.ts 동작과 동일)
    const { findEventsByFilter } = await import('@demo/shared')
    const openEvents = await findEventsByFilter(db, 'test-cluster', { status: 'open' })

    expect(openEvents.length).toBe(1)

    const result = await evaluateAndPersist({
      db,
      openEvents,
      prom:           makeNoopMetrics(),
      injectedPolicy: makePolicy(),
    })

    expect(result.actionsCreated).toBe(1)

    const actions = await findRecentActions(db, 'test-cluster')
    const action = actions[0]

    // 연결 확인: bottleneck 유형 → 올바른 액션
    expect(action.actionType).toBe('scale_up_request')
    expect(action.ruleId).toBe('RULE_CONN_001')
    expect(action.result).toBe('not_executed')   // 자동 실행 없음
    expect(action.mode).toBe('dry_run')
    expect(action.reason).toContain('RULE_CONN_001')
    expect(action.reason).toContain('connection_pressure')
    expect(action.cooldownUntil).toBeDefined()
  })

  it('query_inefficiency 이벤트 → notify_only 액션 (scale 없음)', async () => {
    await insertEvent(db, {
      timestamp:          new Date(),
      projectId:          'test-project',
      clusterName:        'test-cluster',
      severity:           'high',
      type:               'query_inefficiency',
      ruleId:             'RULE_QUERY_001',
      summary:            'queryTargeting > 100',
      recommendedActions: ['review_indexes'],
      status:             'open',
      signals:            { avgQueryTargeting: 200 },
    })

    const { findEventsByFilter } = await import('@demo/shared')
    const openEvents = await findEventsByFilter(db, 'test-cluster', { status: 'open' })

    const result = await evaluateAndPersist({
      db, openEvents, prom: makeNoopMetrics(),
      injectedPolicy: makePolicy(),
    })

    const actions = await findRecentActions(db, 'test-cluster')

    expect(actions[0].actionType).toBe('notify_only')
    expect(result.actionsCreated).toBe(1)
    // scale 관련 액션이 없어야 함
    expect(actions.some(a => a.actionType === 'scale_up_request')).toBe(false)
    expect(actions.some(a => a.actionType === 'scale_recommendation')).toBe(false)
  })
})

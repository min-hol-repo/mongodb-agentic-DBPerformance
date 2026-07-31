/**
 * MongoDB 레포지토리 통합 테스트
 * mongodb-memory-server 를 사용하므로 외부 MongoDB 연결이 필요 없다.
 *
 * time-series 컬렉션은 MongoDB 5.0+ 이상 필요.
 * mongodb-memory-server 는 기본적으로 최신 버전을 사용하므로 지원된다.
 */

import { MongoClient } from 'mongodb'
import { MongoMemoryServer } from 'mongodb-memory-server'
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { ensureCollections } from '../db/collections.js'
import { _injectDb, _resetDb } from '../db/client.js'

// ── 레포지토리 함수들 ─────────────────────────────────────────────
import {
  insertMetrics,
  queryRecentMetrics,
  queryMetricsRange,
  queryLatestMetrics,
} from '../db/repositories/metrics.js'

import {
  insertEvent,
  findRecentEvents,
  findOpenEventByType,
  updateEventStatus,
} from '../db/repositories/events.js'

import {
  insertAction,
  findRecentActions,
  findLastActionByType,
  findPendingActions,
  updateActionStatus,
} from '../db/repositories/actions.js'

import {
  upsertPolicy,
  findOrCreatePolicy,
  defaultPolicy,
} from '../db/repositories/policies.js'

import type { NormalizedMetrics } from '../types/metrics.js'
import type { BottleneckEvent } from '../types/events.js'
import type { ActuatorAction } from '../types/actions.js'
import type { Db } from 'mongodb'

// ── 테스트 픽스처 ─────────────────────────────────────────────────

const SAMPLE_METRICS: NormalizedMetrics = {
  connections: 500,
  cpuNormalizedPct: 40,
  memoryUsedPct: 60,
  diskUsedGb: 200,
  diskQueueDepth: 1.0,
  readLatencyMs: 10,
  writeLatencyMs: 15,
  queryTargeting: 20,
}

const SAMPLE_EVENT: BottleneckEvent = {
  timestamp: new Date(),
  projectId: 'test-project',
  clusterName: 'test-cluster',
  severity: 'high',
  type: 'connection_pressure',
  ruleId: 'RULE_CONN_001',
  summary: '연결 수 초과',
  recommendedActions: ['check_pooling'],
  status: 'open',
}

const SAMPLE_ACTION: ActuatorAction = {
  timestamp: new Date(),
  clusterName: 'test-cluster',
  actionType: 'scale_recommendation',
  mode: 'dry_run',
  reason: 'RULE_CONN_001',
  beforeState: { tier: 'M30' },
  proposedState: { tier: 'M40' },
  result: 'pending',
}

// ── 테스트 셋업 ───────────────────────────────────────────────────

let mongod: MongoMemoryServer
let mongoClient: MongoClient
let db: Db

beforeAll(async () => {
  mongod = await MongoMemoryServer.create()
  mongoClient = new MongoClient(mongod.getUri())
  await mongoClient.connect()
  db = mongoClient.db('test_db')
  await ensureCollections(db)
  _injectDb(mongoClient, db)
})

afterAll(async () => {
  _resetDb()
  await mongoClient.close()
  await mongod.stop()
})

afterEach(async () => {
  // 각 테스트 후 컬렉션 초기화 (time-series는 drop 후 재생성)
  try { await db.collection('bottleneck_events').deleteMany({}) } catch {}
  try { await db.collection('actuator_actions').deleteMany({}) } catch {}
  try { await db.collection('actuator_policies').deleteMany({}) } catch {}
  // time-series는 deleteMany 대신 drop 후 재생성
  try {
    await db.collection('atlas_metrics_ts').drop()
    await db.createCollection('atlas_metrics_ts', {
      timeseries: { timeField: 'timestamp', metaField: 'meta', granularity: 'seconds' },
    })
  } catch {}
})

// ── MetricsRepository 테스트 ──────────────────────────────────────

describe('MetricsRepository', () => {
  it('메트릭을 삽입하고 최근 조회가 가능하다', async () => {
    await insertMetrics(db, {
      clusterName: 'test-cluster',
      projectId: 'proj-1',
      source: 'mock',
      metrics: SAMPLE_METRICS,
    })

    const docs = await queryRecentMetrics(db, 'test-cluster', 5)
    expect(docs).toHaveLength(1)
    expect(docs[0].metrics.connections).toBe(500)
    expect(docs[0].meta.clusterName).toBe('test-cluster')
  })

  it('다른 클러스터 메트릭은 조회되지 않는다', async () => {
    await insertMetrics(db, { clusterName: 'other-cluster', projectId: 'p', source: 's', metrics: SAMPLE_METRICS })
    const docs = await queryRecentMetrics(db, 'test-cluster', 5)
    expect(docs).toHaveLength(0)
  })

  it('시간 범위 조회가 동작한다', async () => {
    const now = new Date()
    const past = new Date(now.getTime() - 60_000)
    await insertMetrics(db, { clusterName: 'test-cluster', projectId: 'p', source: 's', metrics: SAMPLE_METRICS, timestamp: past })
    await insertMetrics(db, { clusterName: 'test-cluster', projectId: 'p', source: 's', metrics: SAMPLE_METRICS, timestamp: now })

    const from = new Date(now.getTime() - 90_000)
    const to = new Date(now.getTime() + 1000)
    const docs = await queryMetricsRange(db, 'test-cluster', from, to)
    expect(docs.length).toBeGreaterThanOrEqual(2)
  })

  it('최신 메트릭 1건을 반환한다', async () => {
    const t1 = new Date(Date.now() - 10_000)
    const t2 = new Date()
    await insertMetrics(db, { clusterName: 'test-cluster', projectId: 'p', source: 's', metrics: { ...SAMPLE_METRICS, connections: 100 }, timestamp: t1 })
    await insertMetrics(db, { clusterName: 'test-cluster', projectId: 'p', source: 's', metrics: { ...SAMPLE_METRICS, connections: 999 }, timestamp: t2 })

    const latest = await queryLatestMetrics(db, 'test-cluster')
    expect(latest).not.toBeNull()
    expect(latest!.metrics.connections).toBe(999)
  })

  it('데이터가 없으면 null을 반환한다', async () => {
    const result = await queryLatestMetrics(db, 'empty-cluster')
    expect(result).toBeNull()
  })
})

// ── EventsRepository 테스트 ──────────────────────────────────────

describe('EventsRepository', () => {
  it('이벤트를 삽입하고 _id를 반환한다', async () => {
    const id = await insertEvent(db, SAMPLE_EVENT)
    expect(typeof id).toBe('string')
    expect(id).toHaveLength(24)   // ObjectId hex
  })

  it('최근 이벤트 목록을 조회한다', async () => {
    await insertEvent(db, SAMPLE_EVENT)
    await insertEvent(db, { ...SAMPLE_EVENT, type: 'cpu_saturation' })

    const events = await findRecentEvents(db, 'test-cluster')
    expect(events.length).toBeGreaterThanOrEqual(2)
    expect(events[0]).toHaveProperty('_id')
  })

  it('open 상태의 특정 타입 이벤트를 찾는다', async () => {
    await insertEvent(db, SAMPLE_EVENT)   // connection_pressure, open

    const found = await findOpenEventByType(db, 'test-cluster', 'connection_pressure')
    expect(found).not.toBeNull()
    expect(found!.status).toBe('open')
    expect(found!.type).toBe('connection_pressure')
  })

  it('resolved 이벤트는 findOpenEventByType 에서 반환되지 않는다', async () => {
    const id = await insertEvent(db, SAMPLE_EVENT)
    await updateEventStatus(db, id, 'resolved')

    const found = await findOpenEventByType(db, 'test-cluster', 'connection_pressure')
    expect(found).toBeNull()
  })

  it('이벤트 상태를 업데이트한다', async () => {
    const id = await insertEvent(db, SAMPLE_EVENT)
    await updateEventStatus(db, id, 'suppressed')

    const events = await findRecentEvents(db, 'test-cluster')
    const updated = events.find(e => e._id === id)
    expect(updated?.status).toBe('suppressed')
  })
})

// ── ActionsRepository 테스트 ─────────────────────────────────────

describe('ActionsRepository', () => {
  it('액션을 삽입하고 _id를 반환한다', async () => {
    const id = await insertAction(db, SAMPLE_ACTION)
    expect(typeof id).toBe('string')
  })

  it('최근 액션을 최신순으로 조회한다', async () => {
    await insertAction(db, SAMPLE_ACTION)
    await insertAction(db, { ...SAMPLE_ACTION, actionType: 'notify_only' })

    const actions = await findRecentActions(db, 'test-cluster')
    expect(actions.length).toBeGreaterThanOrEqual(2)
  })

  it('actionType 별 최신 액션을 조회한다 (cooldown 체크용)', async () => {
    await insertAction(db, { ...SAMPLE_ACTION, actionType: 'scale_recommendation' })
    await insertAction(db, { ...SAMPLE_ACTION, actionType: 'notify_only' })

    const last = await findLastActionByType(db, 'test-cluster', 'scale_recommendation')
    expect(last).not.toBeNull()
    expect(last!.actionType).toBe('scale_recommendation')
  })

  it('pending 상태 액션만 조회한다', async () => {
    const id1 = await insertAction(db, { ...SAMPLE_ACTION, result: 'pending' })
    const id2 = await insertAction(db, { ...SAMPLE_ACTION, result: 'not_executed' })

    const pending = await findPendingActions(db, 'test-cluster')
    const ids = pending.map(a => a._id)
    expect(ids).toContain(id1)
    expect(ids).not.toContain(id2)
  })

  it('액션 상태를 approved로 업데이트한다', async () => {
    const id = await insertAction(db, SAMPLE_ACTION)
    const approvedAt = new Date()
    await updateActionStatus(db, id, 'approved', { approvedAt })

    const actions = await findRecentActions(db, 'test-cluster')
    const updated = actions.find(a => a._id === id)
    expect(updated?.result).toBe('approved')
    expect(updated?.approvedAt).toBeDefined()
  })
})

// ── PoliciesRepository 테스트 ────────────────────────────────────

describe('PoliciesRepository', () => {
  it('정책이 없으면 기본 정책을 생성 후 반환한다', async () => {
    const policy = await findOrCreatePolicy(db, 'new-cluster')
    expect(policy.clusterName).toBe('new-cluster')
    expect(policy.mode).toBe('dry_run')
    expect(policy.maxTier).toBe('M60')
  })

  it('정책을 upsert하고 다시 조회한다', async () => {
    const custom = { ...defaultPolicy('test-cluster'), mode: 'approval_required' as const, maxTier: 'M50' }
    await upsertPolicy(db, custom)

    const found = await findOrCreatePolicy(db, 'test-cluster')
    expect(found.mode).toBe('approval_required')
    expect(found.maxTier).toBe('M50')
  })

  it('동일 클러스터 정책을 두 번 upsert해도 중복되지 않는다', async () => {
    await upsertPolicy(db, defaultPolicy('dup-cluster'))
    await upsertPolicy(db, { ...defaultPolicy('dup-cluster'), maxTier: 'M80' })

    const col = db.collection('actuator_policies')
    const count = await col.countDocuments({ clusterName: 'dup-cluster' })
    expect(count).toBe(1)

    const policy = await findOrCreatePolicy(db, 'dup-cluster')
    expect(policy.maxTier).toBe('M80')
  })

  it('blockedActions에 scale_down이 없으면 기본값 그대로다', async () => {
    const policy = await findOrCreatePolicy(db, 'safe-cluster')
    expect(policy.blockedActions).not.toContain('scale_down')
  })
})

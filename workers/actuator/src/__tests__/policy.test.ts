/**
 * Actuator Policy Engine 통합 테스트
 *
 * 범위:
 *   1. dry_run 모드 — 액션 생성 (not_executed)
 *   2. approval_required 모드 — 액션 생성 (pending)
 *   3. auto_execute — dry_run으로 fallback
 *   4. Guardrail: allowActions 목록 확인
 *   5. Guardrail: blockedActions 목록 확인
 *   6. Guardrail: cooldown 체크
 *   7. Guardrail: max tier 이미 최대일 때 skip
 *   8. Guardrail: 동일 actionType pending 중 중복 방지
 *   9. query_inefficiency → notify_only (scale 절대 금지)
 *  10. 여러 이벤트 동시 처리
 *  11. db=null 모드 (시뮬레이션만)
 */

import { MongoClient } from 'mongodb'
import type { Db } from 'mongodb'
import { MongoMemoryServer } from 'mongodb-memory-server'
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import {
  ensureCollections,
  findRecentActions,
  findPendingActions,
  findActionById,
  insertAction,
  recordTransition,
  _injectDb,
  _resetDb,
  type EventWithId,
  type ActuatorPolicy,
} from '@demo/shared'
import { isTransitionAllowed } from '@demo/shared'
import { evaluateAndPersist } from '../policy.js'
import { makeNoopMetrics } from '../metrics.js'

// ── 셋업 ─────────────────────────────────────────────────────────

let mongod: MongoMemoryServer
let mongoClient: MongoClient
let db: Db

beforeAll(async () => {
  mongod      = await MongoMemoryServer.create()
  mongoClient = new MongoClient(mongod.getUri())
  await mongoClient.connect()
  db = mongoClient.db('actuator_test')
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
})

// ── 픽스처 헬퍼 ──────────────────────────────────────────────────

function makeEvent(
  overrides: Partial<EventWithId> = {},
): EventWithId {
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
    signals:           { avgConnections: 950 },
    ...overrides,
  } as EventWithId
}

function makePolicy(overrides: Partial<ActuatorPolicy> = {}): ActuatorPolicy {
  return {
    clusterName:    'test-cluster',
    mode:           'dry_run',
    maxTier:        'M60',
    cooldownMinutes: 30,
    allowActions:   ['scale_recommendation', 'scale_up_request', 'notify_only'],
    blockedActions: [],
    updatedAt:      new Date(),
    ...overrides,
  }
}

// ── 1. dry_run 모드 ───────────────────────────────────────────────

describe('dry_run 모드', () => {
  it('액션을 생성하고 result = not_executed 로 저장한다', async () => {
    const result = await evaluateAndPersist({
      db,
      openEvents:     [makeEvent()],
      prom:           makeNoopMetrics(),
      injectedPolicy: makePolicy({ mode: 'dry_run' }),
    })

    expect(result.actionsCreated).toBe(1)
    expect(result.actionsSkipped).toBe(0)

    const actions = await findRecentActions(db, 'test-cluster')
    expect(actions).toHaveLength(1)
    expect(actions[0].result).toBe('not_executed')
    expect(actions[0].mode).toBe('dry_run')
  })

  it('connection_pressure high → scale_up_request', async () => {
    await evaluateAndPersist({
      db,
      openEvents:     [makeEvent({ severity: 'high', type: 'connection_pressure' })],
      prom:           makeNoopMetrics(),
      injectedPolicy: makePolicy(),
    })

    const actions = await findRecentActions(db, 'test-cluster')
    expect(actions[0].actionType).toBe('scale_up_request')
  })

  it('connection_pressure medium → scale_recommendation', async () => {
    await evaluateAndPersist({
      db,
      openEvents:     [makeEvent({ severity: 'medium', type: 'connection_pressure' })],
      prom:           makeNoopMetrics(),
      injectedPolicy: makePolicy(),
    })

    const actions = await findRecentActions(db, 'test-cluster')
    expect(actions[0].actionType).toBe('scale_recommendation')
  })

  it('액션에 beforeState / proposedState / cooldownUntil 포함', async () => {
    await evaluateAndPersist({
      db,
      openEvents:     [makeEvent()],
      prom:           makeNoopMetrics(),
      injectedPolicy: makePolicy({ maxTier: 'M50' }),
    })

    const actions = await findRecentActions(db, 'test-cluster')
    const a = actions[0]
    expect(a.beforeState).toBeDefined()
    expect(a.proposedState).toBeDefined()
    expect(a.cooldownUntil).toBeDefined()
    expect(new Date(a.cooldownUntil!)).toBeInstanceOf(Date)
  })
})

// ── 2. approval_required 모드 ─────────────────────────────────────

describe('approval_required 모드', () => {
  it('result = pending 으로 저장된다', async () => {
    await evaluateAndPersist({
      db,
      openEvents:     [makeEvent()],
      prom:           makeNoopMetrics(),
      injectedPolicy: makePolicy({ mode: 'approval_required' }),
    })

    const actions = await findRecentActions(db, 'test-cluster')
    expect(actions[0].result).toBe('pending')
    expect(actions[0].mode).toBe('approval_required')
  })

  it('pending 액션이 findPendingActions 로 조회된다', async () => {
    await evaluateAndPersist({
      db,
      openEvents:     [makeEvent()],
      prom:           makeNoopMetrics(),
      injectedPolicy: makePolicy({ mode: 'approval_required' }),
    })

    const pending = await findPendingActions(db, 'test-cluster')
    expect(pending).toHaveLength(1)
  })
})

// ── 3. auto_execute → dry_run fallback ───────────────────────────

describe('auto_execute → dry_run fallback', () => {
  it('auto_execute 는 not_executed 로 저장 (dry_run 동작)', async () => {
    await evaluateAndPersist({
      db,
      openEvents:     [makeEvent()],
      prom:           makeNoopMetrics(),
      injectedPolicy: makePolicy({ mode: 'auto_execute' }),
    })

    const actions = await findRecentActions(db, 'test-cluster')
    expect(actions[0].result).toBe('not_executed')
    // mode는 dry_run으로 fallback
    expect(actions[0].mode).toBe('dry_run')
  })
})

// ── 4. Guardrail: allowActions ────────────────────────────────────

describe('Guardrail: allowActions', () => {
  it('actionType이 allowActions에 없으면 skip', async () => {
    const result = await evaluateAndPersist({
      db,
      openEvents:     [makeEvent({ severity: 'high', type: 'connection_pressure' })],
      prom:           makeNoopMetrics(),
      injectedPolicy: makePolicy({
        allowActions: ['notify_only'],   // scale_up_request 없음
      }),
    })

    expect(result.actionsCreated).toBe(0)
    expect(result.actionsSkipped).toBe(1)
    expect(result.skipReasons[0].reason).toContain('not_in_allow_list')
  })
})

// ── 5. Guardrail: blockedActions ──────────────────────────────────

describe('Guardrail: blockedActions', () => {
  it('actionType이 blockedActions에 있으면 skip', async () => {
    const result = await evaluateAndPersist({
      db,
      openEvents:     [makeEvent({ severity: 'high' })],
      prom:           makeNoopMetrics(),
      injectedPolicy: makePolicy({
        blockedActions: ['scale_up_request'],
      }),
    })

    expect(result.actionsCreated).toBe(0)
    expect(result.skipReasons[0].reason).toContain('in_blocked_list')
  })
})

// ── 6. Guardrail: cooldown ────────────────────────────────────────

describe('Guardrail: cooldown', () => {
  it('cooldown 내 동일 actionType이면 skip', async () => {
    // 1차: 액션 생성
    await evaluateAndPersist({
      db,
      openEvents:     [makeEvent()],
      prom:           makeNoopMetrics(),
      injectedPolicy: makePolicy({ cooldownMinutes: 30 }),
    })

    // 2차: cooldown 내 재시도 → skip
    const result = await evaluateAndPersist({
      db,
      openEvents:     [makeEvent({ _id: 'evt-002' } as EventWithId)],
      prom:           makeNoopMetrics(),
      injectedPolicy: makePolicy({ cooldownMinutes: 30 }),
    })

    expect(result.actionsCreated).toBe(0)
    expect(result.skipReasons[0].reason).toContain('in_cooldown')
  })

  it('cooldown 0분이면 즉시 재실행 가능', async () => {
    await evaluateAndPersist({
      db,
      openEvents:     [makeEvent()],
      prom:           makeNoopMetrics(),
      injectedPolicy: makePolicy({ cooldownMinutes: 0 }),
    })

    const result = await evaluateAndPersist({
      db,
      openEvents:     [makeEvent({ _id: 'evt-003' } as EventWithId)],
      prom:           makeNoopMetrics(),
      injectedPolicy: makePolicy({ cooldownMinutes: 0 }),
    })

    expect(result.actionsCreated).toBe(1)
  })
})

// ── 7. Guardrail: max tier ────────────────────────────────────────

describe('Guardrail: max tier', () => {
  it('이미 최상위 티어(M400)이면 scale skip', async () => {
    const result = await evaluateAndPersist({
      db,
      openEvents:     [makeEvent()],
      prom:           makeNoopMetrics(),
      injectedPolicy: makePolicy({ maxTier: 'M400' }),   // 최상위
    })

    expect(result.actionsCreated).toBe(0)
    expect(result.skipReasons[0].reason).toContain('already_at_max_tier')
  })

  it('최상위가 아니면 scale 가능', async () => {
    const result = await evaluateAndPersist({
      db,
      openEvents:     [makeEvent()],
      prom:           makeNoopMetrics(),
      injectedPolicy: makePolicy({ maxTier: 'M50' }),   // 다음 = M60
    })

    expect(result.actionsCreated).toBe(1)
    const actions = await findRecentActions(db, 'test-cluster')
    expect(actions[0].proposedState).toMatchObject({ tier: 'M60' })
  })
})

// ── 8. Guardrail: 중복 pending 방지 ──────────────────────────────

describe('Guardrail: 중복 pending 방지', () => {
  it('이미 같은 actionType이 pending 중이면 skip', async () => {
    // 수동으로 pending 액션 삽입
    await insertAction(db, {
      timestamp:   new Date(),
      clusterName: 'test-cluster',
      actionType:  'scale_up_request',
      mode:        'approval_required',
      reason:      'manual',
      result:      'pending',
    })

    const result = await evaluateAndPersist({
      db,
      openEvents:     [makeEvent()],
      prom:           makeNoopMetrics(),
      injectedPolicy: makePolicy({ mode: 'dry_run', cooldownMinutes: 0 }),
    })

    expect(result.actionsCreated).toBe(0)
    expect(result.skipReasons[0].reason).toContain('pending_exists')
  })
})

// ── 9. query_inefficiency → notify_only ──────────────────────────

describe('query_inefficiency → notify_only (scale 절대 금지)', () => {
  it('high severity query_inefficiency도 notify_only 생성', async () => {
    await evaluateAndPersist({
      db,
      openEvents: [makeEvent({
        type:     'query_inefficiency',
        severity: 'high',
        ruleId:   'RULE_QUERY_001',
      })],
      prom:           makeNoopMetrics(),
      injectedPolicy: makePolicy(),
    })

    const actions = await findRecentActions(db, 'test-cluster')
    expect(actions[0].actionType).toBe('notify_only')
  })

  it('notify_only는 beforeState/proposedState가 scale 정보 아님', async () => {
    await evaluateAndPersist({
      db,
      openEvents: [makeEvent({ type: 'query_inefficiency', ruleId: 'RULE_QUERY_001' })],
      prom:           makeNoopMetrics(),
      injectedPolicy: makePolicy(),
    })

    const actions = await findRecentActions(db, 'test-cluster')
    // beforeState.tier 없음 (scale이 아니므로)
    expect(actions[0].beforeState?.tier).toBeUndefined()
  })
})

// ── 10. 여러 이벤트 동시 처리 ────────────────────────────────────

describe('여러 이벤트 동시 처리', () => {
  it('다른 타입의 이벤트는 각각 액션 생성', async () => {
    const result = await evaluateAndPersist({
      db,
      openEvents: [
        makeEvent({ _id: 'e1', type: 'connection_pressure', ruleId: 'RULE_CONN_001', severity: 'high' }),
        makeEvent({ _id: 'e2', type: 'cpu_saturation',      ruleId: 'RULE_CPU_001',  severity: 'medium' }),
        makeEvent({ _id: 'e3', type: 'query_inefficiency',  ruleId: 'RULE_QUERY_001', severity: 'high' }),
      ] as EventWithId[],
      prom:           makeNoopMetrics(),
      injectedPolicy: makePolicy({ cooldownMinutes: 0 }),
    })

    expect(result.actionsCreated).toBe(3)
    const actions = await findRecentActions(db, 'test-cluster', 10)
    const types = actions.map(a => a.actionType)
    expect(types).toContain('scale_up_request')      // connection_pressure high
    expect(types).toContain('scale_recommendation')  // cpu_saturation medium
    expect(types).toContain('notify_only')            // query_inefficiency
  })

  it('이번 사이클 내 같은 actionType 두 번째는 skip (중복 방지)', async () => {
    // 두 이벤트가 같은 actionType을 유발하는 경우
    const result = await evaluateAndPersist({
      db,
      openEvents: [
        makeEvent({ _id: 'e1', type: 'connection_pressure', severity: 'high', ruleId: 'RULE_CONN_001' }),
        makeEvent({ _id: 'e2', type: 'cpu_saturation',      severity: 'high', ruleId: 'RULE_CPU_001' }),
      ] as EventWithId[],
      prom:           makeNoopMetrics(),
      injectedPolicy: makePolicy({ cooldownMinutes: 0 }),
    })

    // 둘 다 scale_up_request → 첫 번째만 생성, 두 번째는 pending_exists skip
    expect(result.actionsCreated).toBe(1)
    expect(result.actionsSkipped).toBe(1)
    expect(result.skipReasons[0].reason).toContain('pending_exists')
  })
})

// ── 11. db=null 모드 ──────────────────────────────────────────────

describe('db=null 모드 (시뮬레이션)', () => {
  it('db=null 이면 DB 저장 없이 결과만 반환', async () => {
    const result = await evaluateAndPersist({
      db:             null,
      openEvents:     [makeEvent()],
      prom:           makeNoopMetrics(),
      injectedPolicy: makePolicy(),
    })

    // actionsCreated는 증가하지만 실제 DB 저장은 없음
    expect(result.actionsCreated).toBe(1)

    // DB에 실제 저장된 액션은 없어야 함
    const dbActions = await findRecentActions(db, 'test-cluster')
    expect(dbActions).toHaveLength(0)
  })
})

// ── 12. actuator_actions 저장 필드 완전성 검증 ───────────────────

describe('actuator_actions 저장 필드 완전성', () => {
  const REQUIRED_FIELDS = [
    'timestamp', 'clusterName', 'actionType', 'mode',
    'reason', 'result', 'cooldownUntil',
  ] as const

  it('저장된 액션에 필수 필드가 모두 존재한다', async () => {
    await evaluateAndPersist({
      db,
      openEvents:     [makeEvent()],
      prom:           makeNoopMetrics(),
      injectedPolicy: makePolicy(),
    })

    const actions = await findRecentActions(db, 'test-cluster')
    expect(actions.length).toBeGreaterThan(0)

    const a = actions[0]
    for (const field of REQUIRED_FIELDS) {
      expect(a, `field '${field}' should exist`).toHaveProperty(field)
      expect((a as unknown as Record<string, unknown>)[field], `field '${field}' should not be undefined`).toBeDefined()
    }
  })

  it('mode 필드가 dry_run | approval_required 중 하나다', async () => {
    await evaluateAndPersist({
      db,
      openEvents:     [makeEvent()],
      prom:           makeNoopMetrics(),
      injectedPolicy: makePolicy({ mode: 'dry_run' }),
    })

    const actions = await findRecentActions(db, 'test-cluster')
    expect(['dry_run', 'approval_required']).toContain(actions[0].mode)
  })

  it('reason 필드에 ruleId와 bottleneck type이 포함된다', async () => {
    await evaluateAndPersist({
      db,
      openEvents:     [makeEvent({ ruleId: 'RULE_CONN_001', type: 'connection_pressure' })],
      prom:           makeNoopMetrics(),
      injectedPolicy: makePolicy(),
    })

    const actions = await findRecentActions(db, 'test-cluster')
    expect(actions[0].reason).toContain('RULE_CONN_001')
    expect(actions[0].reason).toContain('connection_pressure')
  })

  it('scale 액션에 beforeState.tier + proposedState.tier 포함', async () => {
    await evaluateAndPersist({
      db,
      openEvents:     [makeEvent({ severity: 'high' })],
      prom:           makeNoopMetrics(),
      injectedPolicy: makePolicy({ maxTier: 'M50' }),
    })

    const actions = await findRecentActions(db, 'test-cluster')
    const a = actions[0]
    expect(a.beforeState).toHaveProperty('tier')
    expect(a.proposedState).toHaveProperty('tier')
    // proposedState.tier는 maxTier 다음 단계
    expect(a.proposedState!.tier).toBe('M60')
  })

  it('result = not_executed (dry_run) / pending (approval_required)', async () => {
    await evaluateAndPersist({
      db,
      openEvents:     [makeEvent()],
      prom:           makeNoopMetrics(),
      injectedPolicy: makePolicy({ mode: 'dry_run' }),
    })
    const dryActions = await findRecentActions(db, 'test-cluster')
    expect(dryActions[0].result).toBe('not_executed')

    // approval_required
    await evaluateAndPersist({
      db,
      openEvents:     [makeEvent({ _id: 'evt-apr' } as EventWithId)],
      prom:           makeNoopMetrics(),
      injectedPolicy: makePolicy({ mode: 'approval_required', cooldownMinutes: 0 }),
    })
    const allActions = await findRecentActions(db, 'test-cluster', 10)
    const pendingOnes = allActions.filter(a => a.result === 'pending')
    expect(pendingOnes.length).toBeGreaterThan(0)
  })

  it('cooldownUntil이 현재 시각 이후다', async () => {
    const before = new Date()

    await evaluateAndPersist({
      db,
      openEvents:     [makeEvent()],
      prom:           makeNoopMetrics(),
      injectedPolicy: makePolicy({ cooldownMinutes: 30 }),
    })

    const actions = await findRecentActions(db, 'test-cluster')
    const cooldown = new Date(actions[0].cooldownUntil!)
    expect(cooldown.getTime()).toBeGreaterThan(before.getTime())
    // 30분 쿨다운이므로 now + 29분 이후여야 함
    expect(cooldown.getTime()).toBeGreaterThan(before.getTime() + 29 * 60 * 1000)
  })

  it('ruleId 필드가 이벤트의 ruleId와 일치한다', async () => {
    await evaluateAndPersist({
      db,
      openEvents:     [makeEvent({ ruleId: 'RULE_DISK_001' })],
      prom:           makeNoopMetrics(),
      injectedPolicy: makePolicy(),
    })

    const actions = await findRecentActions(db, 'test-cluster')
    expect(actions[0].ruleId).toBe('RULE_DISK_001')
  })
})

// ── 13. Approval Flow — 상태 전이 + 감사 로그 ────────────────────

describe('Approval Flow — 상태 전이 및 감사 추적 검증', () => {

  // ── 상태 머신 규칙 검증 ────────────────────────────────────────

  it('isTransitionAllowed: pending→approved 허용', () => {
    expect(isTransitionAllowed('pending', 'approved')).toBe(true)
  })

  it('isTransitionAllowed: pending→rejected 허용', () => {
    expect(isTransitionAllowed('pending', 'rejected')).toBe(true)
  })

  it('isTransitionAllowed: approved→* 차단', () => {
    expect(isTransitionAllowed('approved', 'rejected')).toBe(false)
    expect(isTransitionAllowed('approved', 'pending')).toBe(false)
  })

  it('isTransitionAllowed: rejected→* 차단', () => {
    expect(isTransitionAllowed('rejected', 'approved')).toBe(false)
  })

  it('isTransitionAllowed: not_executed→* 차단 (dry-run 결과 불변)', () => {
    expect(isTransitionAllowed('not_executed', 'approved')).toBe(false)
    expect(isTransitionAllowed('not_executed', 'rejected')).toBe(false)
  })

  // ── approve 흐름 ─────────────────────────────────────────────

  it('approval_required 모드 → pending 액션 생성 → approve → approved', async () => {
    // 1단계: pending 액션 생성
    await evaluateAndPersist({
      db,
      openEvents:     [makeEvent()],
      prom:           makeNoopMetrics(),
      injectedPolicy: makePolicy({ mode: 'approval_required' }),
    })

    const pending = await findPendingActions(db, 'test-cluster')
    expect(pending).toHaveLength(1)
    expect(pending[0].result).toBe('pending')
    const actionId = pending[0]._id

    // 2단계: approve
    const approved = await recordTransition(db, actionId, {
      from:  'pending',
      to:    'approved',
      actor: 'operator',
    })

    expect(approved).not.toBeNull()
    expect(approved!.result).toBe('approved')
    expect(approved!.approvedAt).toBeDefined()
    expect(new Date(approved!.approvedAt!)).toBeInstanceOf(Date)
  })

  it('approve 후 auditLog에 전이 항목이 기록된다', async () => {
    await evaluateAndPersist({
      db,
      openEvents:     [makeEvent({ _id: 'audit-evt' } as EventWithId)],
      prom:           makeNoopMetrics(),
      injectedPolicy: makePolicy({ mode: 'approval_required', cooldownMinutes: 0 }),
    })

    const pending  = await findPendingActions(db, 'test-cluster')
    const actionId = pending[0]._id

    await recordTransition(db, actionId, {
      from:  'pending',
      to:    'approved',
      actor: 'operator',
    })

    const action = await findActionById(db, actionId)
    expect(action).not.toBeNull()
    expect(action!.auditLog).toBeDefined()
    expect(action!.auditLog!.length).toBeGreaterThanOrEqual(1)

    const entry = action!.auditLog!.at(-1)!
    expect(entry.from).toBe('pending')
    expect(entry.to).toBe('approved')
    expect(entry.actor).toBe('operator')
    expect(entry.at).toBeDefined()
  })

  // ── reject 흐름 ─────────────────────────────────────────────

  it('pending 액션 → reject → rejected + rejectedAt + note 기록', async () => {
    await evaluateAndPersist({
      db,
      openEvents:     [makeEvent({ _id: 'rej-evt' } as EventWithId)],
      prom:           makeNoopMetrics(),
      injectedPolicy: makePolicy({ mode: 'approval_required', cooldownMinutes: 0 }),
    })

    const pending  = await findPendingActions(db, 'test-cluster')
    const actionId = pending[0]._id

    const rejected = await recordTransition(db, actionId, {
      from:  'pending',
      to:    'rejected',
      actor: 'operator',
      note:  '현재 메트릭이 안정화 중 — scale 불필요',
    })

    expect(rejected!.result).toBe('rejected')
    expect(rejected!.rejectedAt).toBeDefined()

    // auditLog에 note가 기록되었는지 확인
    const action = await findActionById(db, actionId)
    const entry  = action!.auditLog!.at(-1)!
    expect(entry.to).toBe('rejected')
    expect(entry.note).toBe('현재 메트릭이 안정화 중 — scale 불필요')
  })

  // ── 중복 전이 차단 ────────────────────────────────────────────

  it('이미 approved → approve 재시도 → null 반환 (낙관적 잠금)', async () => {
    // 1차 approve
    const id = await insertAction(db, {
      timestamp:   new Date(),
      clusterName: 'test-cluster',
      actionType:  'scale_up_request',
      mode:        'approval_required',
      reason:      'test',
      result:      'pending',
    })

    await recordTransition(db, id, { from: 'pending', to: 'approved', actor: 'operator' })

    // 2차 approve 시도 → 이미 approved이므로 낙관적 잠금 실패
    const second = await recordTransition(db, id, { from: 'pending', to: 'approved', actor: 'operator' })
    expect(second).toBeNull()   // from='pending' 조건이 맞지 않으므로 null
  })

  it('이미 rejected → approve 시도 → null (상태 불일치)', async () => {
    const id = await insertAction(db, {
      timestamp:   new Date(),
      clusterName: 'test-cluster',
      actionType:  'scale_recommendation',
      mode:        'approval_required',
      reason:      'test',
      result:      'pending',
    })

    await recordTransition(db, id, { from: 'pending', to: 'rejected', actor: 'operator' })

    // approve 시도 → 이미 rejected이므로 실패
    const attempt = await recordTransition(db, id, { from: 'pending', to: 'approved', actor: 'operator' })
    expect(attempt).toBeNull()

    // DB에는 rejected 상태가 유지되어야 함
    const action = await findActionById(db, id)
    expect(action!.result).toBe('rejected')
  })

  // ── 감사 로그 불변성 ─────────────────────────────────────────

  it('auditLog는 누적만 되고 이전 항목이 사라지지 않는다', async () => {
    const id = await insertAction(db, {
      timestamp:   new Date(),
      clusterName: 'test-cluster',
      actionType:  'notify_only',
      mode:        'approval_required',
      reason:      'test',
      result:      'pending',
    })

    // approve
    await recordTransition(db, id, { from: 'pending', to: 'approved', actor: 'operator', note: 'ok' })

    const action = await findActionById(db, id)
    expect(action!.auditLog).toBeDefined()
    expect(action!.auditLog!.length).toBeGreaterThanOrEqual(1)

    // 기존 항목이 그대로 있는지 확인
    const entry = action!.auditLog![0]
    expect(entry.from).toBe('pending')
    expect(entry.to).toBe('approved')
    expect(entry.note).toBe('ok')
  })

  // ── findActionById ────────────────────────────────────────────

  it('findActionById: 잘못된 ID → null 반환', async () => {
    const result = await findActionById(db, 'not-a-valid-id')
    expect(result).toBeNull()
  })

  it('findActionById: 존재하지 않는 ID → null 반환', async () => {
    const result = await findActionById(db, '000000000000000000000001')
    expect(result).toBeNull()
  })

  it('findActionById: 삽입 후 조회 성공', async () => {
    const id = await insertAction(db, {
      timestamp:   new Date(),
      clusterName: 'test-cluster',
      actionType:  'scale_recommendation',
      mode:        'dry_run',
      reason:      'test',
      result:      'not_executed',
    })

    const action = await findActionById(db, id)
    expect(action).not.toBeNull()
    expect(action!._id).toBe(id)
    expect(action!.result).toBe('not_executed')
    expect(action!.auditLog).toEqual([])   // 빈 배열로 초기화
  })
})

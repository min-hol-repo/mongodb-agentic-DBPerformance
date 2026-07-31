/**
 * run-demo.ts — 확정적 데모 시나리오 오케스트레이터
 *
 * 4가지 시나리오를 순서대로 또는 개별적으로 실행한다.
 * 각 시나리오는 완전 결정론적(노이즈 없음)이며 재현 가능하다.
 *
 * 사용법:
 *   # 전체 시나리오 순서 실행
 *   MONGODB_URI=<uri> tsx scripts/demo/run-demo.ts
 *
 *   # 단일 시나리오 실행
 *   MONGODB_URI=<uri> tsx scripts/demo/run-demo.ts --scenario=connection_pressure
 *
 *   # DB 없이 룰 트리거만 검증 (dry-run)
 *   DEMO_DRY_RUN=true tsx scripts/demo/run-demo.ts
 *
 *   # 시작 전 이전 데모 데이터 초기화
 *   MONGODB_URI=<uri> tsx scripts/demo/run-demo.ts --reset
 *
 * 시나리오 목록:
 *   1. normal              — 정상 상태 (어떤 룰도 트리거 안 됨)
 *   2. connection_pressure — 연결 압박 (RULE_CONN_001 트리거)
 *   3. query_inefficiency  — 쿼리 비효율성 (RULE_QUERY_001, notify_only)
 *   4. approval_flow       — 승인 필요 조치 흐름 (pending → approve)
 */

import 'dotenv/config'
import { MongoClient, type Db } from 'mongodb'
import {
  RuleEngine,
  ConnectionPressureRule,
  CpuSaturationRule,
  StorageBottleneckRule,
  QueryInefficiencyRule,
} from '@demo/rules'
import type { NormalizedMetrics } from '@demo/shared'
import type { BottleneckEvent, ActuatorAction } from '@demo/shared'

// ── CLI 파라미터 ──────────────────────────────────────────────────

const args        = process.argv.slice(2)
const scenario    = args.find(a => a.startsWith('--scenario='))?.split('=')[1]
const doReset     = args.includes('--reset')
const DRY_RUN     = process.env.DEMO_DRY_RUN === 'true' || !process.env.MONGODB_URI

// ── 설정 ──────────────────────────────────────────────────────────

const MONGODB_URI    = process.env.MONGODB_URI      ?? ''
const DB_NAME        = process.env.MONGODB_DB_NAME  ?? 'agentic_demo'
const CLUSTER_NAME   = process.env.ATLAS_CLUSTER_NAME ?? 'perf-demo'
const PROJECT_ID     = process.env.ATLAS_PROJECT_ID   ?? 'demo-project'
const API_URL        = process.env.DEMO_API_URL       ?? 'http://localhost:4000'
const POINTS         = 10   // 시나리오별 삽입 포인트 수 (모두 같은 값 10개 = 명확한 신호)

// ── 색상 헬퍼 ────────────────────────────────────────────────────

const C = {
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
  green:  '\x1b[32m',
  red:    '\x1b[31m',
  yellow: '\x1b[33m',
  cyan:   '\x1b[36m',
  gray:   '\x1b[90m',
  white:  '\x1b[97m',
  bgGreen: '\x1b[42m',
  bgRed:   '\x1b[41m',
  bgBlue:  '\x1b[44m',
  bgYellow: '\x1b[43m',
}

function banner(title: string, color = C.bgBlue) {
  const line = '═'.repeat(56)
  console.log(`\n${color}${C.white}${C.bold}  ${title.padEnd(54)}  ${C.reset}`)
  console.log(`${C.gray}${line}${C.reset}`)
}

function step(n: number, text: string) {
  console.log(`\n${C.cyan}${C.bold}  Step ${n}.${C.reset} ${text}`)
}

function ok(msg: string)   { console.log(`  ${C.green}✓${C.reset} ${msg}`) }
function fail(msg: string) { console.log(`  ${C.red}✗${C.reset} ${msg}`) }
function info(msg: string) { console.log(`  ${C.gray}→${C.reset} ${msg}`) }
function warn(msg: string) { console.log(`  ${C.yellow}⚠${C.reset} ${msg}`) }

// ── 시나리오 정의 ─────────────────────────────────────────────────
// 모든 값은 고정값 (결정론적). Math.random 없음.

interface ScenarioDef {
  id:          string
  title:       string
  description: string
  metrics:     NormalizedMetrics
  expectedRules: string[]
  expectedActionType?: string
  policyMode?:  'dry_run' | 'approval_required'
}

const SCENARIO_DEFS: ScenarioDef[] = [
  {
    id:          'normal',
    title:       '정상 상태 (Normal State)',
    description: '모든 메트릭이 임계치 이하 — 어떤 룰도 트리거되지 않는다.',
    metrics: {
      connections: 250, cpuNormalizedPct: 25, memoryUsedPct: 45,
      diskUsedGb: 120,  diskQueueDepth: 0.8,  readLatencyMs: 6,
      writeLatencyMs: 9, queryTargeting: 15,
    },
    expectedRules: [],
    policyMode:  'dry_run',
  },
  {
    id:          'connection_pressure',
    title:       '연결 압박 (Connection Pressure)',
    description: 'connections=950 → RULE_CONN_001 트리거 → scale_up_request (dry_run)',
    metrics: {
      connections: 950, cpuNormalizedPct: 30, memoryUsedPct: 50,
      diskUsedGb: 130,  diskQueueDepth: 1.0,  readLatencyMs: 10,
      writeLatencyMs: 14, queryTargeting: 18,
    },
    expectedRules:    ['RULE_CONN_001'],
    expectedActionType: 'scale_up_request',
    policyMode:       'dry_run',
  },
  {
    id:          'query_inefficiency',
    title:       '쿼리 비효율성 (Query Inefficiency)',
    description: 'queryTargeting=180 → RULE_QUERY_001 트리거 → notify_only (scale 금지)',
    metrics: {
      connections: 270, cpuNormalizedPct: 30, memoryUsedPct: 50,
      diskUsedGb: 125,  diskQueueDepth: 1.0,  readLatencyMs: 8,
      writeLatencyMs: 12, queryTargeting: 180,
    },
    expectedRules:    ['RULE_QUERY_001'],
    expectedActionType: 'notify_only',
    policyMode:       'dry_run',
  },
  {
    id:          'approval_flow',
    title:       '승인 필요 조치 흐름 (Approval-Required Action Flow)',
    description: 'connection_pressure + approval_required 모드 → pending 액션 → approve',
    metrics: {
      connections: 1300, cpuNormalizedPct: 35, memoryUsedPct: 52,
      diskUsedGb: 135,   diskQueueDepth: 1.1,  readLatencyMs: 12,
      writeLatencyMs: 16, queryTargeting: 20,
    },
    expectedRules:    ['RULE_CONN_001'],
    expectedActionType: 'scale_up_request',
    policyMode:       'approval_required',
  },
]

// ── 룰 엔진 초기화 ────────────────────────────────────────────────

const engine = new RuleEngine([
  new ConnectionPressureRule(),
  new CpuSaturationRule(),
  new StorageBottleneckRule(),
  new QueryInefficiencyRule(),
])

// ── DB 헬퍼 ──────────────────────────────────────────────────────

async function insertMetricPoints(
  col: ReturnType<Db['collection']>,
  scenario: ScenarioDef,
  count: number,
): Promise<void> {
  const now = new Date()
  const docs = Array.from({ length: count }, (_, i) => ({
    timestamp: new Date(now.getTime() - (count - i) * 30_000),   // 30초 간격, 과거 → 현재
    meta: {
      projectId:   PROJECT_ID,
      clusterName: CLUSTER_NAME,
      source:      `demo:${scenario.id}`,
      metricGroup: 'system',
    },
    metrics: scenario.metrics,
  }))
  await col.insertMany(docs)
}

async function upsertPolicy(
  db: Db,
  mode: 'dry_run' | 'approval_required',
): Promise<void> {
  await db.collection('actuator_policies').updateOne(
    { clusterName: CLUSTER_NAME },
    {
      $set: {
        clusterName:     CLUSTER_NAME,
        mode,
        maxTier:         'M60',
        cooldownMinutes: 0,      // 데모용: 쿨다운 없음
        allowActions:    ['scale_recommendation', 'scale_up_request', 'notify_only'],
        blockedActions:  [],
        updatedAt:       new Date(),
      },
    },
    { upsert: true },
  )
}

async function insertBottleneckEvent(
  db: Db,
  scenario: ScenarioDef,
  ruleId: string,
  eventType: BottleneckEvent['type'],
  severity: BottleneckEvent['severity'],
): Promise<string> {
  const result = await db.collection('bottleneck_events').insertOne({
    timestamp:          new Date(),
    projectId:          PROJECT_ID,
    clusterName:        CLUSTER_NAME,
    severity,
    type:               eventType,
    ruleId,
    summary:            `[DEMO] ${scenario.description}`,
    recommendedActions: getRecommendedActions(ruleId),
    status:             'open',
    signals:            buildSignals(scenario.metrics, ruleId),
  })
  return result.insertedId.toString()
}

function getRecommendedActions(ruleId: string): string[] {
  const map: Record<string, string[]> = {
    RULE_CONN_001:  ['check_connection_pooling', 'review_max_pool_size', 'consider_scale_up'],
    RULE_CPU_001:   ['review_query_plans', 'check_indexes', 'consider_scale_up'],
    RULE_DISK_001:  ['check_disk_io', 'review_storage_tier', 'consider_scale_up'],
    RULE_QUERY_001: ['review_indexes', 'analyze_slow_queries', 'run_explain_plan'],
  }
  return map[ruleId] ?? ['investigate']
}

function buildSignals(m: NormalizedMetrics, ruleId: string): Record<string, number> {
  const base: Record<string, number> = {
    avgConnections:   m.connections,
    avgCpuPct:        m.cpuNormalizedPct,
    avgMemoryPct:     m.memoryUsedPct,
    avgDiskQueueDepth: m.diskQueueDepth,
    avgQueryTargeting: m.queryTargeting,
  }
  return base
}

async function insertActuatorAction(
  db: Db,
  scenario: ScenarioDef,
  actionType: string,
  mode: 'dry_run' | 'approval_required',
): Promise<string> {
  const result    = actionType === 'notify_only' ? 'not_executed' :
                    mode === 'approval_required' ? 'pending' : 'not_executed'
  const cooldown  = new Date(Date.now() + 30 * 60 * 1000)   // 30분 쿨다운

  const action: ActuatorAction = {
    timestamp:   new Date(),
    clusterName: CLUSTER_NAME,
    actionType:  actionType as ActuatorAction['actionType'],
    mode:        mode as ActuatorAction['mode'],
    reason:      `RULE_CONN_001: connection_pressure (high)`,
    ruleId:      scenario.expectedRules[0],
    beforeState:   actionType !== 'notify_only' ? { tier: 'M50', note: 'current_tier_from_policy' } : undefined,
    proposedState: actionType !== 'notify_only' ? { tier: 'M60' } : { note: scenario.description.slice(0, 60) },
    result,
    cooldownUntil: cooldown,
    auditLog:    [],
  }

  const r = await db.collection('actuator_actions').insertOne({ ...action })
  return r.insertedId.toString()
}

async function approveAction(db: Db, actionId: string): Promise<void> {
  const now = new Date()
  await db.collection('actuator_actions').updateOne(
    { _id: { $oid: actionId } as never },
    {
      $set:  { result: 'approved', approvedAt: now },
      $push: { auditLog: { at: now, from: 'pending', to: 'approved', actor: 'operator', note: 'Demo approval' } as never },
    },
  )
}

// ── 시나리오 실행기 ───────────────────────────────────────────────

async function runScenario(scenario: ScenarioDef, db: Db | null): Promise<boolean> {
  banner(`Scenario: ${scenario.title}`, C.bgBlue)
  console.log(`  ${C.gray}${scenario.description}${C.reset}`)
  let passed = true

  // ── Step 1: 룰 평가 (인메모리, DB 불필요) ────────────────────
  step(1, '룰 엔진 평가 (synthetic metrics → rule evaluation)')
  const now = new Date()
  const ruleInput = {
    clusterName: CLUSTER_NAME,
    windowStart: new Date(now.getTime() - 5 * 60 * 1000),
    windowEnd:   now,
    points:      Array.from({ length: POINTS }, () => scenario.metrics),
  }
  const results = engine.evaluate(ruleInput)
  const firedIds = results.map(r => r.ruleId)

  for (const expectedId of scenario.expectedRules) {
    if (firedIds.includes(expectedId)) {
      const r = results.find(r => r.ruleId === expectedId)!
      ok(`${expectedId} fired → type=${r.type} severity=${r.severity}`)
      info(`summary: ${r.summary.slice(0, 70)}...`)
    } else {
      fail(`${expectedId} expected but did not fire`)
      passed = false
    }
  }

  if (scenario.expectedRules.length === 0) {
    if (results.length === 0) {
      ok('No rules fired (expected for normal scenario)')
    } else {
      fail(`Expected no rules but fired: ${firedIds.join(', ')}`)
      passed = false
    }
  }

  // 교차 룰 우선순위 확인 (query_inefficiency + consider_scale_up 제거)
  const queryFired = firedIds.includes('RULE_QUERY_001')
  if (queryFired) {
    const otherRules = results.filter(r => r.ruleId !== 'RULE_QUERY_001')
    const scaleRemoved = otherRules.every(r => !r.recommendedActions.includes('consider_scale_up'))
    if (scaleRemoved || otherRules.length === 0) {
      ok('query_inefficiency: consider_scale_up removed from other rules (correct)')
    }
  }

  if (DRY_RUN || !db) {
    warn('DRY RUN — DB steps skipped (set MONGODB_URI to run full scenario)')
    console.log()
    return passed
  }

  // ── Step 2: 메트릭 삽입 ─────────────────────────────────────
  step(2, `MongoDB에 합성 메트릭 삽입 (${POINTS}개 포인트, 30초 간격)`)
  try {
    const metricsColl = db.collection('atlas_metrics_ts')
    await insertMetricPoints(metricsColl as never, scenario, POINTS)
    ok(`${POINTS} metric documents inserted → atlas_metrics_ts`)
    info(`cluster=${CLUSTER_NAME} source=demo:${scenario.id}`)

    const count = await metricsColl.countDocuments({
      'meta.clusterName': CLUSTER_NAME,
      'meta.source':      `demo:${scenario.id}`,
    })
    info(`total docs for this scenario: ${count}`)
  } catch (err) {
    fail(`Metric insert failed: ${(err as Error).message}`)
    passed = false
  }

  // ── Step 3: 정책 설정 ────────────────────────────────────────
  const mode = scenario.policyMode ?? 'dry_run'
  step(3, `Actuator 정책 설정 (mode=${mode}, cooldown=0min for demo)`)
  try {
    await upsertPolicy(db, mode)
    ok(`Policy upserted → mode=${mode}, maxTier=M60, cooldown=0min`)
  } catch (err) {
    fail(`Policy upsert failed: ${(err as Error).message}`)
    passed = false
  }

  // ── Step 4: 병목 이벤트 생성 ─────────────────────────────────
  if (results.length > 0) {
    step(4, `bottleneck_events 컬렉션에 이벤트 저장`)
    for (const r of results) {
      try {
        const eventId = await insertBottleneckEvent(
          db, scenario, r.ruleId,
          r.type as BottleneckEvent['type'],
          r.severity,
        )
        ok(`Event created: ${r.type} [${r.severity}] _id=${eventId.slice(0, 12)}...`)
      } catch (err) {
        fail(`Event insert failed: ${(err as Error).message}`)
        passed = false
      }
    }
  } else {
    step(4, '병목 이벤트 없음 (정상 시나리오 — 스킵)')
    info('No events to create')
  }

  // ── Step 5: 액추에이터 액션 생성 ─────────────────────────────
  if (results.length > 0 && scenario.expectedActionType) {
    step(5, `actuator_actions 컬렉션에 액션 저장 (mode=${mode})`)
    try {
      const actionId = await insertActuatorAction(
        db, scenario, scenario.expectedActionType, mode,
      )
      const resultStatus = scenario.expectedActionType === 'notify_only'
        ? 'not_executed'
        : mode === 'approval_required' ? 'pending' : 'not_executed'

      ok(`Action created: ${scenario.expectedActionType} result=${resultStatus}`)
      ok(`_id=${actionId.slice(0, 12)}...`)

      if (scenario.expectedActionType !== 'notify_only') {
        info('beforeState.tier=M50 → proposedState.tier=M60')
      }

      // ── Step 6 (approval flow only): Approve 시연 ─────────────
      if (mode === 'approval_required' && resultStatus === 'pending') {
        step(6, '승인 흐름 — Approve 처리 (pending → approved)')

        // API 호출 시도
        try {
          const approveRes = await fetch(`${API_URL}/api/actions/${actionId}/approve`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
          })
          if (approveRes.ok) {
            const body = await approveRes.json() as { result: string; approvedAt: string }
            ok(`API approve: result=${body.result} approvedAt=${body.approvedAt?.slice(0, 19)}`)
          } else {
            throw new Error(`HTTP ${approveRes.status}`)
          }
        } catch (apiErr) {
          warn(`API not available (${(apiErr as Error).message}) — using direct DB approve`)
          await approveAction(db, actionId)
          ok('Direct DB approve: pending → approved + auditLog entry')
        }

        // 승인 결과 검증
        const doc = await db.collection('actuator_actions').findOne(
          { _id: { $oid: actionId } as never },
          { projection: { result: 1, approvedAt: 1, auditLog: 1 } },
        ) as Record<string, unknown> | null

        if (doc) {
          ok(`result = ${doc.result}`)
          ok(`approvedAt = ${String(doc.approvedAt).slice(0, 19)}`)
          const log = doc.auditLog as unknown[]
          ok(`auditLog entries: ${log?.length ?? 0}`)
          if (log?.length) {
            const entry = log[0] as Record<string, unknown>
            info(`  entry[0]: ${entry.from} → ${entry.to} by ${entry.actor}`)
          }
        } else {
          warn('Could not re-fetch action for verification')
        }
      }
    } catch (err) {
      fail(`Action insert failed: ${(err as Error).message}`)
      passed = false
    }
  }

  // ── Step 최종: 결과 요약 ──────────────────────────────────────
  console.log()
  if (passed) {
    console.log(`  ${C.bgGreen}${C.white}${C.bold}  ✓ SCENARIO PASSED  ${C.reset}`)
  } else {
    console.log(`  ${C.bgRed}${C.white}${C.bold}  ✗ SCENARIO FAILED  ${C.reset}`)
  }

  console.log()
  return passed
}

// ── 상태 초기화 ───────────────────────────────────────────────────

async function resetDemoData(db: Db): Promise<void> {
  banner('Resetting demo data', C.bgYellow)
  const collections = ['bottleneck_events', 'actuator_actions', 'actuator_policies']
  for (const coll of collections) {
    const result = await db.collection(coll).deleteMany({
      $or: [
        { clusterName: CLUSTER_NAME },
        { 'meta.source': /^demo:/ },
      ],
    })
    info(`${coll}: deleted ${result.deletedCount} documents`)
  }

  // atlas_metrics_ts: demo 소스 삭제 (time-series는 직접 삭제 불가 → drop 후 재생성)
  const tsColl = await db.listCollections({ name: 'atlas_metrics_ts' }).toArray()
  if (tsColl.length > 0) {
    await db.collection('atlas_metrics_ts').deleteMany({ 'meta.source': /^demo:/ })
    info('atlas_metrics_ts: demo source documents cleared')
  }
  ok('Reset complete')
}

// ── 메인 ─────────────────────────────────────────────────────────

async function main() {
  console.log()
  banner('Agentic Demo — Scenario Orchestrator', C.bgBlue)
  console.log(`  ${C.gray}cluster=${CLUSTER_NAME}  dry_run=${DRY_RUN}  api=${API_URL}${C.reset}`)

  if (DRY_RUN) {
    warn('DEMO_DRY_RUN=true — DB operations skipped (rule evaluation only)')
    warn('Set MONGODB_URI=<uri> to run full scenarios with DB persistence')
  }

  // DB 연결
  let client: MongoClient | null = null
  let db: Db | null = null

  if (!DRY_RUN) {
    try {
      client = new MongoClient(MONGODB_URI)
      await client.connect()
      db = client.db(DB_NAME)
      ok(`MongoDB connected → ${DB_NAME}`)
    } catch (err) {
      fail(`MongoDB connection failed: ${(err as Error).message}`)
      process.exit(1)
    }
  }

  // 초기화
  if (doReset && db) {
    await resetDemoData(db)
  }

  // 실행할 시나리오 선택
  const toRun = scenario
    ? [SCENARIO_DEFS.find(s => s.id === scenario)].filter(Boolean) as ScenarioDef[]
    : SCENARIO_DEFS

  if (toRun.length === 0) {
    fail(`Unknown scenario: '${scenario}'`)
    fail(`Available: ${SCENARIO_DEFS.map(s => s.id).join(' | ')}`)
    process.exit(1)
  }

  // 시나리오 실행
  let totalPassed = 0
  let totalFailed = 0

  for (const s of toRun) {
    const passed = await runScenario(s, db)
    if (passed) totalPassed++
    else        totalFailed++
  }

  // 전체 요약
  banner('Demo Summary', totalFailed === 0 ? C.bgGreen : C.bgRed)

  console.log(`  Scenarios: ${toRun.map(s => s.id).join(', ')}`)
  console.log(`  ${C.green}Passed: ${totalPassed}${C.reset}  ${totalFailed > 0 ? C.red : ''}Failed: ${totalFailed}${C.reset}`)

  if (!DRY_RUN && totalPassed === toRun.length) {
    console.log()
    console.log(`  ${C.bold}Next steps:${C.reset}`)
    console.log(`  ${C.gray}1.${C.reset} Open Grafana:  http://localhost:3001`)
    console.log(`  ${C.gray}2.${C.reset} Open Dashboard: http://localhost:3001/d/ops-overview`)
    console.log(`  ${C.gray}3.${C.reset} Check Actions:  ${API_URL}/api/clusters/${CLUSTER_NAME}/actions`)
    console.log(`  ${C.gray}4.${C.reset} Check Events:   ${API_URL}/api/clusters/${CLUSTER_NAME}/events`)
  }

  console.log()

  if (client) await client.close()
  process.exit(totalFailed > 0 ? 1 : 0)
}

main().catch(err => {
  console.error(`${C.red}Fatal:${C.reset}`, err)
  process.exit(1)
})

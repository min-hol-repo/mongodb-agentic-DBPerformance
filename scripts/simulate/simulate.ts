/**
 * simulate.ts — 시나리오 시뮬레이터
 *
 * 선택한 시나리오에 맞는 현재 상태를 DB에 설정하고,
 * 이후 해당 메트릭을 지속적으로 삽입한다.
 * Grafana에서 변화를 실시간으로 볼 수 있다.
 *
 * 단계:
 *   1. 설정 단계 (setup): 지난 5분 메트릭 삽입 + 기존 open 이벤트 해소
 *   2. 지속 단계 (loop): INTERVAL_MS마다 새 포인트 삽입 (Ctrl+C 종료)
 *
 * 사용법:
 *   MONGODB_URI=<uri> tsx scripts/simulate/simulate.ts --scenario=normal
 *   pnpm --filter @demo/scripts simulate:normal
 *   pnpm --filter @demo/scripts simulate:connection
 *   pnpm --filter @demo/scripts simulate:query
 *   pnpm --filter @demo/scripts simulate:approval
 *
 * 옵션 환경변수:
 *   MONGODB_URI           MongoDB URI
 *   ATLAS_CLUSTER_NAME    기본: perf-demo
 *   SIMULATE_INTERVAL_MS  삽입 간격 ms (기본: 5000 = 5초)
 *   SIMULATE_SETUP_POINTS 설정 단계 포인트 수 (기본: 10 = 5분 분량)
 *   SIMULATE_MODE         dry_run | approval_required (actuator 정책)
 */

import 'dotenv/config'
import { MongoClient, type Db } from 'mongodb'
import type { NormalizedMetrics } from '@demo/shared'

// ── CLI 파라미터 ──────────────────────────────────────────────────

const args     = process.argv.slice(2)
const SCENARIO = (args.find(a => a.startsWith('--scenario='))?.split('=')[1] ?? process.argv[2] ?? 'normal').replace(/-/g, '_')

// ── 설정 ──────────────────────────────────────────────────────────

const MONGODB_URI    = process.env.MONGODB_URI            ?? ''
const DB_NAME        = process.env.MONGODB_DB_NAME        ?? 'agentic_demo'
const CLUSTER        = process.env.ATLAS_CLUSTER_NAME     ?? 'perf-demo'
const PROJECT_ID     = process.env.ATLAS_PROJECT_ID       ?? 'demo-project'
const INTERVAL_MS    = Number(process.env.SIMULATE_INTERVAL_MS  ?? 5_000)
const SETUP_POINTS   = Number(process.env.SIMULATE_SETUP_POINTS ?? 10)
const POLICY_MODE    = (process.env.SIMULATE_MODE ?? 'dry_run') as 'dry_run' | 'approval_required'

if (!MONGODB_URI) {
  console.error('\x1b[31mError:\x1b[0m MONGODB_URI is required')
  console.error('Usage: MONGODB_URI=<uri> pnpm --filter @demo/scripts simulate:normal')
  process.exit(1)
}

// ── 시나리오 정의 (결정론적 고정값) ──────────────────────────────

interface ScenarioDef {
  id:          string
  label:       string
  description: string
  metrics:     NormalizedMetrics
  policyMode:  'dry_run' | 'approval_required'
  /** 시뮬레이션 시작 시 보여줄 UI 확인 포인트 */
  watchPoints: string[]
}

const SCENARIOS: Record<string, ScenarioDef> = {
  normal: {
    id:          'normal',
    label:       '정상 상태',
    description: '모든 메트릭 정상 범위 — 병목 이벤트 없음',
    metrics: {
      connections: 250, cpuNormalizedPct: 25, memoryUsedPct: 45,
      diskUsedGb: 120,  diskQueueDepth: 0.8,  readLatencyMs: 6,
      writeLatencyMs: 9, queryTargeting: 15,
    },
    policyMode:  'dry_run',
    watchPoints: [
      'Grafana: Open Events = 0',
      'Grafana: Service Status — 모두 녹색',
      'API: GET /api/clusters/perf-demo/events?status=open → []',
    ],
  },

  connection_pressure: {
    id:          'connection_pressure',
    label:       '연결 압박',
    description: 'connections=950 → RULE_CONN_001 → scale_up_request (dry_run)',
    metrics: {
      connections: 950, cpuNormalizedPct: 35, memoryUsedPct: 52,
      diskUsedGb: 130,  diskQueueDepth: 1.1,  readLatencyMs: 15,
      writeLatencyMs: 20, queryTargeting: 18,
    },
    policyMode:  'dry_run',
    watchPoints: [
      'Grafana: Connections Gauge — 주황/빨강으로 변경',
      'Grafana: High-Severity Events 증가',
      'Grafana: Actuator Actions 생성됨',
      'API: GET /api/clusters/perf-demo/events?status=open → connection_pressure event',
      'API: GET /api/clusters/perf-demo/actions → scale_up_request (not_executed)',
    ],
  },

  query_inefficiency: {
    id:          'query_inefficiency',
    label:       '쿼리 비효율성',
    description: 'queryTargeting=180 → RULE_QUERY_001 → notify_only (scale 금지)',
    metrics: {
      connections: 270, cpuNormalizedPct: 30, memoryUsedPct: 50,
      diskUsedGb: 125,  diskQueueDepth: 1.0,  readLatencyMs: 8,
      writeLatencyMs: 12, queryTargeting: 180,
    },
    policyMode:  'dry_run',
    watchPoints: [
      'Grafana: Query Targeting Gauge — 빨강으로 변경',
      'Grafana: Events by Type — query_inefficiency 증가',
      'API: GET /api/clusters/perf-demo/events → query_inefficiency (open)',
      'API: GET /api/clusters/perf-demo/actions → notify_only (not scale!)',
      '주목: considerScaleUp이 actions에 없음 — 인덱스 우선 원칙 확인',
    ],
  },

  approval_flow: {
    id:          'approval_flow',
    label:       '승인 필요 조치 흐름',
    description: 'connections=1300 + approval_required → pending action → approve',
    metrics: {
      connections: 1300, cpuNormalizedPct: 42, memoryUsedPct: 55,
      diskUsedGb: 138,   diskQueueDepth: 1.3,  readLatencyMs: 20,
      writeLatencyMs: 26, queryTargeting: 22,
    },
    policyMode:  'approval_required',
    watchPoints: [
      '1. Grafana: Open Events — connection_pressure high',
      '2. Grafana: Pending Approvals — 카운트 증가',
      '3. API: GET /api/clusters/perf-demo/actions?result=pending → scale_up_request',
      '4. Dashboard /actions 페이지: Approve 버튼 활성화됨',
      '5. Approve 클릭 후: result=approved + auditLog 확인',
      '6. API: GET /api/actions/<id> → auditLog[0].to = "approved"',
    ],
  },
}

// ── 헬퍼 ──────────────────────────────────────────────────────────

const G = '\x1b[32m'; const R = '\x1b[31m'; const Y = '\x1b[33m'
const C = '\x1b[36m'; const B = '\x1b[1m';  const E = '\x1b[0m'
const ok   = (m: string) => console.log(`  ${G}✓${E} ${m}`)
const fail = (m: string) => console.log(`  ${R}✗${E} ${m}`)
const info = (m: string) => console.log(`  ${Y}→${E} ${m}`)
const head = (m: string) => console.log(`\n${B}${C}── ${m} ──${E}`)
const step = (n: number, m: string) => console.log(`\n${B}  Step ${n}.${E} ${m}`)

// ── 설정 단계 함수 ────────────────────────────────────────────────

async function setupScenario(db: Db, def: ScenarioDef): Promise<void> {

  // 1. 기존 open 이벤트를 모두 해소 (다른 시나리오 잔재 제거)
  step(1, '이전 시나리오 open 이벤트 해소')
  const resolveResult = await db.collection('bottleneck_events').updateMany(
    { clusterName: CLUSTER, status: 'open' },
    { $set: { status: 'resolved' } },
  )
  if (resolveResult.modifiedCount > 0) {
    info(`Resolved ${resolveResult.modifiedCount} existing open events`)
  } else {
    info('No existing open events to resolve')
  }

  // 2. Actuator 정책 설정
  step(2, `Actuator 정책 설정 (mode=${def.policyMode}, cooldown=0min for demo)`)
  await db.collection('actuator_policies').updateOne(
    { clusterName: CLUSTER },
    {
      $set: {
        clusterName:     CLUSTER,
        mode:            def.policyMode,
        maxTier:         'M60',
        cooldownMinutes: 0,      // 데모에서 쿨다운 없이 즉시 액션 생성
        allowActions:    ['scale_recommendation', 'scale_up_request', 'notify_only'],
        blockedActions:  [],
        updatedAt:       new Date(),
      },
    },
    { upsert: true },
  )
  ok(`Policy: mode=${def.policyMode}, maxTier=M60, cooldown=0min`)

  // 3. 과거 5분 메트릭 삽입 (Detector가 즉시 탐지할 수 있도록)
  step(3, `최근 ${SETUP_POINTS}개 포인트 삽입 (지난 5분 대용)`)
  const now = Date.now()
  const setupDocs = Array.from({ length: SETUP_POINTS }, (_, i) => ({
    timestamp: new Date(now - (SETUP_POINTS - i) * 30_000),
    meta: {
      projectId:   PROJECT_ID,
      clusterName: CLUSTER,
      source:      `simulate:${def.id}`,
      metricGroup: 'system',
    },
    metrics: def.metrics,
  }))

  const col = db.collection('atlas_metrics_ts')
  try {
    await col.insertMany(setupDocs)
    ok(`Inserted ${setupDocs.length} metric points (${SETUP_POINTS * 30}s window)`)
    info(`connections=${def.metrics.connections}, cpu=${def.metrics.cpuNormalizedPct}%, queryTargeting=${def.metrics.queryTargeting}`)
  } catch (err) {
    fail(`Metric insert error: ${(err as Error).message}`)
  }
}

// ── 지속 삽입 루프 ────────────────────────────────────────────────

async function runLoop(db: Db, def: ScenarioDef): Promise<void> {
  head(`Running — scenario=${def.id}  interval=${INTERVAL_MS}ms`)
  console.log(`  Press ${B}Ctrl+C${E} to stop\n`)

  const col   = db.collection('atlas_metrics_ts')
  let count   = 0
  const start = Date.now()

  async function insert() {
    await col.insertOne({
      timestamp: new Date(),
      meta: {
        projectId:   PROJECT_ID,
        clusterName: CLUSTER,
        source:      `simulate:${def.id}`,
        metricGroup: 'system',
      },
      metrics: def.metrics,
    })
    count++
    const elapsed = Math.floor((Date.now() - start) / 1000)
    process.stdout.write(
      `\r  ${G}✓${E} #${String(count).padStart(4)} | ${def.id.padEnd(22)} | ` +
      `conn=${def.metrics.connections} cpu=${def.metrics.cpuNormalizedPct}% ` +
      `qt=${def.metrics.queryTargeting} | ${elapsed}s elapsed`,
    )
  }

  await insert()   // 즉시 1회 실행
  const timer = setInterval(() => { insert().catch(console.error) }, INTERVAL_MS)

  const cleanup = async () => {
    clearInterval(timer)
    console.log(`\n\n  ${G}✓${E} Stopped after ${count} inserts`)
    await db.client.close()
    process.exit(0)
  }
  process.on('SIGINT',  () => { void cleanup() })
  process.on('SIGTERM', () => { void cleanup() })
}

// ── 메인 ─────────────────────────────────────────────────────────

async function main() {
  const def = SCENARIOS[SCENARIO]
  if (!def) {
    console.error(`\x1b[31mUnknown scenario: '${SCENARIO}'\x1b[0m`)
    console.error(`Available: ${Object.keys(SCENARIOS).join(' | ')}`)
    process.exit(1)
  }

  // 헤더 출력
  console.log(`\n${B}═══════════════════════════════════════════════════${E}`)
  console.log(`${B}  Simulate: ${def.label}${E}`)
  console.log(`${B}═══════════════════════════════════════════════════${E}`)
  console.log(`  ${def.description}`)
  console.log(`  cluster:  ${CLUSTER}`)
  console.log(`  policy:   ${def.policyMode}`)
  console.log(`  interval: ${INTERVAL_MS}ms`)

  // DB 연결
  let client: MongoClient
  try {
    client = new MongoClient(MONGODB_URI)
    await client.connect()
    ok(`MongoDB connected → ${DB_NAME}`)
  } catch (err) {
    fail(`MongoDB connection failed: ${(err as Error).message}`)
    process.exit(1)
  }

  const db = client.db(DB_NAME)

  // 설정 단계
  await setupScenario(db, def)

  // 시나리오별 watch 포인트 출력
  head('What to watch in the UI')
  for (const pt of def.watchPoints) {
    console.log(`  ${Y}→${E} ${pt}`)
  }

  if (def.policyMode === 'approval_required') {
    console.log(`\n  ${B}Approval Flow API calls:${E}`)
    console.log(`  ${C}# 대기 중인 액션 조회${E}`)
    console.log(`  curl http://localhost:4000/api/clusters/${CLUSTER}/actions?result=pending`)
    console.log()
    console.log(`  ${C}# 액션 승인 (ACTION_ID를 위 결과에서 복사)${E}`)
    console.log(`  curl -X POST http://localhost:4000/api/actions/<ACTION_ID>/approve`)
    console.log()
    console.log(`  ${C}# 액션 거절 (사유 포함)${E}`)
    console.log(`  curl -X POST http://localhost:4000/api/actions/<ACTION_ID>/reject \\`)
    console.log(`    -H "Content-Type: application/json" \\`)
    console.log(`    -d '{"reason":"쿨다운 후 재검토 예정"}'`)
  }

  // 지속 삽입 루프 시작
  await runLoop(db, def)
}

main().catch(err => {
  console.error('\x1b[31mFatal:\x1b[0m', err)
  process.exit(1)
})

/**
 * seed-full-demo.ts — 전체 데모 데이터 시딩
 *
 * 모든 컬렉션에 걸쳐 데모 시연 직전 "살아있는" 상태를 만든다.
 * Grafana 차트, 이벤트 목록, 액션 히스토리 모두 데이터가 채워진 상태가 된다.
 *
 * 삽입 대상:
 *   atlas_metrics_ts     — 60분 분량 합성 메트릭 히스토리 (30초 간격 × 120 포인트)
 *   bottleneck_events    — 과거 이벤트 3개 (resolved) + 현재 open 이벤트 1개
 *   actuator_actions     — 과거 dry_run 액션 + pending 액션 (approval_flow용)
 *   actuator_policies    — 기본 정책 (dry_run, M60, cooldown=30min)
 *
 * 메트릭 타임라인 (60분 전 → 현재):
 *   T-60 ~ T-40: normal       → 정상 구간 (차트 베이스라인)
 *   T-40 ~ T-25: connection_surge → connection_pressure 이벤트 발생·해소
 *   T-25 ~ T-10: normal       → 회복 구간
 *   T-10 ~ T-00: query_inefficiency → 현재 진행 중인 병목
 *
 * 사용법:
 *   MONGODB_URI=<uri> pnpm --filter @demo/scripts seed:full
 *   SEED_DRY_RUN=true pnpm --filter @demo/scripts seed:full   # DB 없이 검증만
 *
 * 환경변수:
 *   MONGODB_URI           MongoDB Atlas URI (필수, dry_run 시 불필요)
 *   MONGODB_DB_NAME       기본: agentic_demo
 *   ATLAS_CLUSTER_NAME    기본: perf-demo
 *   SEED_DRY_RUN          true → DB 없이 타임라인만 출력
 *   SEED_RESET            true → 시딩 전 기존 데모 데이터 삭제
 */

import 'dotenv/config'
import { MongoClient, type Db } from 'mongodb'
import type { NormalizedMetrics } from '@demo/shared'

// ── 설정 ──────────────────────────────────────────────────────────

const MONGODB_URI  = process.env.MONGODB_URI        ?? ''
const DB_NAME      = process.env.MONGODB_DB_NAME    ?? 'agentic_demo'
const CLUSTER      = process.env.ATLAS_CLUSTER_NAME ?? 'perf-demo'
const PROJECT_ID   = process.env.ATLAS_PROJECT_ID   ?? 'demo-project'
const DRY_RUN      = process.env.SEED_DRY_RUN === 'true' || !MONGODB_URI
const DO_RESET     = process.env.SEED_RESET   === 'true'

// ── 색상 ──────────────────────────────────────────────────────────

const G = '\x1b[32m'; const R = '\x1b[31m'; const Y = '\x1b[33m'
const C = '\x1b[36m'; const B = '\x1b[1m';  const E = '\x1b[0m'
const ok   = (m: string) => console.log(`  ${G}✓${E} ${m}`)
const fail = (m: string) => console.log(`  ${R}✗${E} ${m}`)
const info = (m: string) => console.log(`  ${Y}→${E} ${m}`)
const head = (m: string) => console.log(`\n${B}${C}── ${m} ──${E}`)

// ── 메트릭 프리셋 (결정론적, 노이즈 없음) ─────────────────────────

const METRICS: Record<string, NormalizedMetrics> = {
  normal: {
    connections: 250, cpuNormalizedPct: 25, memoryUsedPct: 45,
    diskUsedGb: 120,  diskQueueDepth: 0.8,  readLatencyMs: 6,
    writeLatencyMs: 9, queryTargeting: 15,
  },
  connection_surge: {
    connections: 950, cpuNormalizedPct: 40, memoryUsedPct: 55,
    diskUsedGb: 135,  diskQueueDepth: 1.2,  readLatencyMs: 18,
    writeLatencyMs: 24, queryTargeting: 20,
  },
  connection_high: {
    connections: 1300, cpuNormalizedPct: 45, memoryUsedPct: 58,
    diskUsedGb: 138,   diskQueueDepth: 1.4,  readLatencyMs: 22,
    writeLatencyMs: 28, queryTargeting: 22,
  },
  recovering: {
    connections: 400, cpuNormalizedPct: 28, memoryUsedPct: 48,
    diskUsedGb: 122,  diskQueueDepth: 0.9,  readLatencyMs: 8,
    writeLatencyMs: 11, queryTargeting: 17,
  },
  query_inefficiency: {
    connections: 270, cpuNormalizedPct: 30, memoryUsedPct: 50,
    diskUsedGb: 125,  diskQueueDepth: 1.0,  readLatencyMs: 8,
    writeLatencyMs: 12, queryTargeting: 180,
  },
}

// ── 타임라인 정의 (60분 전 → 현재) ──────────────────────────────
//
// 각 세그먼트: { startMinsAgo, endMinsAgo, metricsKey, label }
// 30초 간격으로 포인트 생성 → 총 120 포인트 (60분)

interface Segment {
  startMinsAgo: number   // 더 오래된 시각
  endMinsAgo:   number   // 더 최근 시각
  metricsKey:   keyof typeof METRICS
  label:        string
}

const TIMELINE: Segment[] = [
  { startMinsAgo: 60, endMinsAgo: 40, metricsKey: 'normal',            label: 'Normal (baseline)' },
  { startMinsAgo: 40, endMinsAgo: 30, metricsKey: 'connection_surge',  label: 'Connection surge begins' },
  { startMinsAgo: 30, endMinsAgo: 26, metricsKey: 'connection_high',   label: 'Connection pressure peak' },
  { startMinsAgo: 26, endMinsAgo: 10, metricsKey: 'recovering',        label: 'Recovering (pool tuned)' },
  { startMinsAgo: 10, endMinsAgo:  0, metricsKey: 'query_inefficiency',label: 'Query inefficiency (ongoing)' },
]

function buildMetricDocs(): Array<{ timestamp: Date; meta: object; metrics: NormalizedMetrics }> {
  const now    = Date.now()
  const docs: Array<{ timestamp: Date; meta: object; metrics: NormalizedMetrics }> = []

  for (const seg of TIMELINE) {
    const segStart = now - seg.startMinsAgo * 60_000
    const segEnd   = now - seg.endMinsAgo   * 60_000
    const duration = segEnd - segStart
    const interval = 30_000   // 30초 간격
    const count    = Math.max(1, Math.floor(duration / interval))

    for (let i = 0; i < count; i++) {
      docs.push({
        timestamp: new Date(segStart + i * interval),
        meta: {
          projectId:   PROJECT_ID,
          clusterName: CLUSTER,
          source:      'seed:full-demo',
          metricGroup: 'system',
        },
        metrics: METRICS[seg.metricsKey],
      })
    }
  }

  return docs.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime())
}

// ── 이벤트 데이터 ─────────────────────────────────────────────────
//
// 메트릭 타임라인에 대응하는 현실적인 이벤트 히스토리

interface EventDef {
  minsAgo:            number
  type:               string
  severity:           string
  ruleId:             string
  summary:            string
  recommendedActions: string[]
  status:             string
  signals:            Record<string, number>
}

const EVENT_DEFS: EventDef[] = [
  {
    minsAgo:  38,
    type:     'connection_pressure',
    severity: 'medium',
    ruleId:   'RULE_CONN_001',
    summary:  '평균 연결 수 950이 임계치(800)를 초과했습니다. Connection pool 설정을 먼저 확인하세요.',
    recommendedActions: ['check_connection_pooling', 'review_max_pool_size', 'check_query_patterns'],
    status:   'resolved',     // 과거 이벤트 — 이미 해소됨
    signals:  { avgConnections: 950, threshold: 800 },
  },
  {
    minsAgo:  28,
    type:     'connection_pressure',
    severity: 'high',
    ruleId:   'RULE_CONN_001',
    summary:  '평균 연결 수 1300이 임계치(1200)를 초과했습니다. (상승 추세) Connection pool 설정을 먼저 확인하세요.',
    recommendedActions: ['check_connection_pooling', 'review_max_pool_size', 'check_query_patterns', 'consider_scale_up'],
    status:   'resolved',
    signals:  { avgConnections: 1300, threshold: 800 },
  },
  {
    minsAgo:   8,
    type:     'query_inefficiency',
    severity: 'medium',
    ruleId:   'RULE_QUERY_001',
    summary:  '쿼리 타겟팅 비율 평균 180 (최대 180)이 높습니다. 인덱스가 부분적으로만 사용되고 있습니다. 리소스 증설 전에 인덱스와 쿼리 플랜을 먼저 검토하세요.',
    recommendedActions: ['review_indexes', 'analyze_slow_queries', 'run_explain_plan', 'add_missing_indexes'],
    status:   'open',         // 현재 진행 중 — 데모에서 이 이벤트를 보여줌
    signals:  { avgQueryTargeting: 180, threshold: 100 },
  },
]

// ── 액션 데이터 ───────────────────────────────────────────────────

interface ActionDef {
  minsAgo:      number
  actionType:   string
  mode:         string
  reason:       string
  ruleId:       string
  beforeState?: object
  proposedState?: object
  result:       string
}

const ACTION_DEFS: ActionDef[] = [
  {
    minsAgo:      37,
    actionType:   'scale_recommendation',
    mode:         'dry_run',
    reason:       'RULE_CONN_001: connection_pressure (medium)',
    ruleId:       'RULE_CONN_001',
    beforeState:  { tier: 'M50', note: 'current_tier_from_policy' },
    proposedState:{ tier: 'M60' },
    result:       'not_executed',
  },
  {
    minsAgo:      27,
    actionType:   'scale_up_request',
    mode:         'dry_run',
    reason:       'RULE_CONN_001: connection_pressure (high)',
    ruleId:       'RULE_CONN_001',
    beforeState:  { tier: 'M50', note: 'current_tier_from_policy' },
    proposedState:{ tier: 'M60' },
    result:       'not_executed',
  },
  {
    minsAgo:      7,
    actionType:   'notify_only',
    mode:         'dry_run',
    reason:       'RULE_QUERY_001: query_inefficiency (medium)',
    ruleId:       'RULE_QUERY_001',
    beforeState:  undefined,
    proposedState:{ note: 'notify_only — query_inefficiency: 쿼리 타겟팅 비율 평균 180 (최대 180)이 높습니다.' },
    result:       'not_executed',
  },
]

// ── DB 시딩 함수 ─────────────────────────────────────────────────

async function resetCollections(db: Db): Promise<void> {
  head('Resetting existing demo data')
  const colls = ['bottleneck_events', 'actuator_actions', 'actuator_policies']
  for (const c of colls) {
    const r = await db.collection(c).deleteMany({ clusterName: CLUSTER })
    info(`${c}: cleared ${r.deletedCount} documents`)
  }
  // time-series: demo 소스만 삭제
  const r2 = await db.collection('atlas_metrics_ts').deleteMany({ 'meta.source': 'seed:full-demo' })
  info(`atlas_metrics_ts: cleared ${r2.deletedCount} demo documents`)
}

async function seedMetrics(db: Db): Promise<number> {
  head('Seeding atlas_metrics_ts (60min history)')

  const docs = buildMetricDocs()

  // time-series 컬렉션 확인
  const existing = await db.listCollections({ name: 'atlas_metrics_ts' }).toArray()
  if (existing.length === 0) {
    await db.createCollection('atlas_metrics_ts', {
      timeseries: { timeField: 'timestamp', metaField: 'meta', granularity: 'seconds' },
    })
    info('Created time-series collection: atlas_metrics_ts')
  }

  // 배치 삽입 (time-series는 한 번에 많이 삽입 가능)
  await db.collection('atlas_metrics_ts').insertMany(docs)
  ok(`Inserted ${docs.length} metric documents`)

  // 타임라인 요약 출력
  for (const seg of TIMELINE) {
    const count = docs.filter(d => {
      const minsAgo = (Date.now() - d.timestamp.getTime()) / 60_000
      return minsAgo >= seg.endMinsAgo && minsAgo < seg.startMinsAgo
    }).length
    info(`T-${seg.startMinsAgo}~T-${seg.endMinsAgo}min: ${seg.metricsKey} (${count} pts) — ${seg.label}`)
  }

  return docs.length
}

async function seedEvents(db: Db): Promise<void> {
  head('Seeding bottleneck_events')

  const now = Date.now()
  let inserted = 0

  for (const def of EVENT_DEFS) {
    await db.collection('bottleneck_events').insertOne({
      timestamp:          new Date(now - def.minsAgo * 60_000),
      projectId:          PROJECT_ID,
      clusterName:        CLUSTER,
      severity:           def.severity,
      type:               def.type,
      ruleId:             def.ruleId,
      summary:            def.summary,
      recommendedActions: def.recommendedActions,
      status:             def.status,
      signals:            def.signals,
    })
    const badge = def.status === 'open' ? `${R}[open]${E}` : `${G}[resolved]${E}`
    ok(`${def.type} ${badge} severity=${def.severity} (${def.minsAgo}min ago)`)
    inserted++
  }

  info(`Total: ${inserted} events (${EVENT_DEFS.filter(e => e.status === 'open').length} open, ${EVENT_DEFS.filter(e => e.status === 'resolved').length} resolved)`)
}

async function seedActions(db: Db): Promise<void> {
  head('Seeding actuator_actions')

  const now = Date.now()
  let inserted = 0

  for (const def of ACTION_DEFS) {
    const cooldownUntil = new Date(now - def.minsAgo * 60_000 + 30 * 60_000)
    await db.collection('actuator_actions').insertOne({
      timestamp:     new Date(now - def.minsAgo * 60_000),
      clusterName:   CLUSTER,
      actionType:    def.actionType,
      mode:          def.mode,
      reason:        def.reason,
      ruleId:        def.ruleId,
      beforeState:   def.beforeState,
      proposedState: def.proposedState,
      result:        def.result,
      cooldownUntil,
      auditLog:      [],
    })
    ok(`${def.actionType} result=${def.result} mode=${def.mode} (${def.minsAgo}min ago)`)
    inserted++
  }

  info(`Total: ${inserted} actions`)
}

async function seedPolicy(db: Db): Promise<void> {
  head('Seeding actuator_policies')

  await db.collection('actuator_policies').updateOne(
    { clusterName: CLUSTER },
    {
      $set: {
        clusterName:     CLUSTER,
        mode:            'dry_run',
        maxTier:         'M60',
        cooldownMinutes: 30,
        allowActions:    ['scale_recommendation', 'scale_up_request', 'notify_only'],
        blockedActions:  [],
        updatedAt:       new Date(),
      },
    },
    { upsert: true },
  )
  ok(`Policy upserted: mode=dry_run, maxTier=M60, cooldown=30min`)
}

// ── dry-run 출력 ──────────────────────────────────────────────────

function printDryRunSummary(): void {
  head('DRY RUN — What would be seeded')
  const metricDocs = buildMetricDocs()

  console.log(`\n  ${B}Metric Timeline (${metricDocs.length} points total):${E}`)
  for (const seg of TIMELINE) {
    const count = Math.max(1, Math.floor((seg.startMinsAgo - seg.endMinsAgo) * 60_000 / 30_000))
    console.log(`    T-${String(seg.startMinsAgo).padStart(2,'0')}~T-${String(seg.endMinsAgo).padStart(2,'0')}min | ${String(count).padStart(3)} pts | ${seg.metricsKey.padEnd(20)} | ${seg.label}`)
  }

  console.log(`\n  ${B}Events (${EVENT_DEFS.length}):${E}`)
  for (const e of EVENT_DEFS) {
    const badge = e.status === 'open' ? `${R}open${E}` : `${G}resolved${E}`
    console.log(`    ${e.type.padEnd(22)} | ${e.severity.padEnd(8)} | ${badge.padEnd(20)} | ${e.minsAgo}min ago`)
  }

  console.log(`\n  ${B}Actions (${ACTION_DEFS.length}):${E}`)
  for (const a of ACTION_DEFS) {
    console.log(`    ${a.actionType.padEnd(22)} | ${a.result.padEnd(14)} | ${a.mode.padEnd(20)} | ${a.minsAgo}min ago`)
  }

  console.log(`\n  ${B}Policy:${E}`)
  console.log(`    mode=dry_run, maxTier=M60, cooldown=30min`)
}

// ── 메인 ─────────────────────────────────────────────────────────

async function main() {
  console.log(`\n${B}═══════════════════════════════════════════════════${E}`)
  console.log(`${B}  Full Demo Data Seed${E}`)
  console.log(`${B}═══════════════════════════════════════════════════${E}`)
  console.log(`  cluster:  ${CLUSTER}`)
  console.log(`  database: ${DB_NAME}`)
  console.log(`  dry_run:  ${DRY_RUN}`)
  console.log(`  reset:    ${DO_RESET}`)

  if (DRY_RUN) {
    printDryRunSummary()
    console.log(`\n${Y}  → Set MONGODB_URI to actually seed the database${E}`)
    return
  }

  let client: MongoClient | null = null
  try {
    client = new MongoClient(MONGODB_URI)
    await client.connect()
    const db = client.db(DB_NAME)
    ok(`MongoDB connected → ${DB_NAME}`)

    if (DO_RESET) {
      await resetCollections(db)
    }

    const metricCount = await seedMetrics(db)
    await seedEvents(db)
    await seedActions(db)
    await seedPolicy(db)

    head('✓ Seed Complete')
    ok(`${metricCount} metric points covering last 60 minutes`)
    ok(`${EVENT_DEFS.length} bottleneck events (${EVENT_DEFS.filter(e => e.status === 'open').length} open)`)
    ok(`${ACTION_DEFS.length} actuator actions`)
    ok(`Actuator policy: dry_run / M60 / 30min cooldown`)

    console.log(`\n  ${B}Next steps:${E}`)
    console.log(`  ${Y}→${E} Open Grafana dashboard: http://localhost:3001/d/ops-overview`)
    console.log(`  ${Y}→${E} Check Events API: http://localhost:4000/api/clusters/${CLUSTER}/events`)
    console.log(`  ${Y}→${E} Check Actions API: http://localhost:4000/api/clusters/${CLUSTER}/actions`)
    console.log(`  ${Y}→${E} Run a scenario:  pnpm --filter @demo/scripts simulate:query`)
    console.log()

  } catch (err) {
    fail(`Seed failed: ${(err as Error).message}`)
    process.exit(1)
  } finally {
    if (client) await client.close()
  }
}

main()

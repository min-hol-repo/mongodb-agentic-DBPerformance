/**
 * seed-synthetic-metrics.ts
 *
 * 시나리오별 합성 메트릭을 atlas_metrics_ts 컬렉션에 삽입하고,
 * 각 시나리오에서 의도한 룰이 정확히 트리거되는지 검증한다.
 *
 * 사용법:
 *   MONGODB_URI=<uri> tsx scripts/seed/seed-synthetic-metrics.ts
 *   또는: pnpm --filter @demo/scripts seed
 *
 * 옵션 환경변수:
 *   MONGODB_URI           MongoDB 연결 URI (필수)
 *   MONGODB_DB_NAME       데이터베이스 이름 (기본: agentic_demo)
 *   ATLAS_CLUSTER_NAME    클러스터 이름 (기본: perf-demo)
 *   SEED_POINTS_PER_SCENARIO  시나리오별 삽입 포인트 수 (기본: 10)
 *   SEED_DRY_RUN          'true'이면 DB insert 없이 시뮬레이션만 실행
 */

import 'dotenv/config'
import { MongoClient } from 'mongodb'
import {
  RuleEngine,
  ConnectionPressureRule,
  CpuSaturationRule,
  StorageBottleneckRule,
  QueryInefficiencyRule,
} from '@demo/rules'
import type { RuleInput, RuleResult } from '@demo/rules'
import type { NormalizedMetrics } from '@demo/shared'

// ── 설정 ──────────────────────────────────────────────────────────

const MONGODB_URI   = process.env.MONGODB_URI      ?? ''
const DB_NAME       = process.env.MONGODB_DB_NAME  ?? 'agentic_demo'
const CLUSTER_NAME  = process.env.ATLAS_CLUSTER_NAME ?? 'perf-demo'
const PROJECT_ID    = process.env.ATLAS_PROJECT_ID  ?? 'demo-project'
const POINTS_PER_SCENARIO = Number(process.env.SEED_POINTS_PER_SCENARIO ?? 10)
const DRY_RUN       = process.env.SEED_DRY_RUN === 'true'

// ── 시나리오 정의 ─────────────────────────────────────────────────
// 각 시나리오는 고정값을 사용한다 (Math.random 없음 = 완전 결정론적).

interface Scenario {
  name:          string
  description:   string
  metrics:       NormalizedMetrics
  expectedRules: string[]   // 반드시 트리거되어야 하는 ruleId 목록
  forbiddenRules: string[]  // 트리거되면 안 되는 ruleId 목록
}

const SCENARIOS: Scenario[] = [
  {
    name:        'normal',
    description: '정상 상태 — 어떤 룰도 트리거되면 안 됨',
    metrics: {
      connections:      250,
      cpuNormalizedPct:  25,
      memoryUsedPct:     45,
      diskUsedGb:       120,
      diskQueueDepth:   0.8,
      readLatencyMs:      6,
      writeLatencyMs:     9,
      queryTargeting:    15,
    },
    expectedRules:  [],
    forbiddenRules: ['RULE_CONN_001', 'RULE_CPU_001', 'RULE_DISK_001', 'RULE_QUERY_001'],
  },
  {
    name:        'connection_surge',
    description: 'RULE_CONN_001 트리거 — connections=950 > 임계치(800)',
    metrics: {
      connections:      950,   // 임계치 800 초과 → low (latency가 낮으므로)
      cpuNormalizedPct:  30,
      memoryUsedPct:     50,
      diskUsedGb:       130,
      diskQueueDepth:   1.0,
      readLatencyMs:     10,   // 20ms 미만 → medium severity
      writeLatencyMs:    14,
      queryTargeting:    18,
    },
    expectedRules:  ['RULE_CONN_001'],
    forbiddenRules: ['RULE_CPU_001', 'RULE_DISK_001', 'RULE_QUERY_001'],
  },
  {
    name:        'connection_surge_high',
    description: 'RULE_CONN_001 high severity — connections=1300 > 임계치(1200)',
    metrics: {
      connections:      1300,  // 1200 초과 → high
      cpuNormalizedPct:  35,
      memoryUsedPct:     52,
      diskUsedGb:       135,
      diskQueueDepth:   1.1,
      readLatencyMs:     12,
      writeLatencyMs:    16,
      queryTargeting:    20,
    },
    expectedRules:  ['RULE_CONN_001'],
    forbiddenRules: ['RULE_CPU_001', 'RULE_DISK_001', 'RULE_QUERY_001'],
  },
  {
    name:        'cpu_saturation',
    description: 'RULE_CPU_001 트리거 — cpu=85% > 임계치(70%)',
    metrics: {
      connections:      300,
      cpuNormalizedPct:  85,   // 임계치 70 초과 → medium
      memoryUsedPct:     60,
      diskUsedGb:       130,
      diskQueueDepth:   1.2,
      readLatencyMs:     15,   // 30ms 미만 → medium (critical 아님)
      writeLatencyMs:    20,
      queryTargeting:    25,
    },
    expectedRules:  ['RULE_CPU_001'],
    forbiddenRules: ['RULE_CONN_001', 'RULE_DISK_001', 'RULE_QUERY_001'],
  },
  {
    name:        'cpu_saturation_high',
    description: 'RULE_CPU_001 high severity — cpu=92% > 임계치(90%)',
    metrics: {
      connections:      320,
      cpuNormalizedPct:  92,   // 90 초과 → high
      memoryUsedPct:     65,
      diskUsedGb:       135,
      diskQueueDepth:   1.3,
      readLatencyMs:     16,
      writeLatencyMs:    22,
      queryTargeting:    28,
    },
    expectedRules:  ['RULE_CPU_001'],
    forbiddenRules: ['RULE_CONN_001', 'RULE_DISK_001', 'RULE_QUERY_001'],
  },
  {
    name:        'storage_pressure_disk',
    description: 'RULE_DISK_001 트리거 (디스크 큐) — diskQueueDepth=5.0 > 임계치(3.0)',
    metrics: {
      connections:      280,
      cpuNormalizedPct:  32,
      memoryUsedPct:     55,
      diskUsedGb:       450,
      diskQueueDepth:   5.0,   // 임계치 3.0 초과 → high (항상)
      readLatencyMs:     55,
      writeLatencyMs:    70,
      queryTargeting:    20,
    },
    expectedRules:  ['RULE_DISK_001'],
    forbiddenRules: ['RULE_CONN_001', 'RULE_CPU_001', 'RULE_QUERY_001'],
  },
  {
    name:        'storage_pressure_memory',
    description: 'RULE_DISK_001 트리거 (메모리) — memoryUsedPct=85% > 임계치(80%)',
    metrics: {
      connections:      290,
      cpuNormalizedPct:  35,
      memoryUsedPct:     85,   // 임계치 80 초과 → high (항상)
      diskUsedGb:       140,
      diskQueueDepth:   1.5,   // 3.0 미만 → disk 큐는 미트리거
      readLatencyMs:     10,
      writeLatencyMs:    14,
      queryTargeting:    22,
    },
    expectedRules:  ['RULE_DISK_001'],
    forbiddenRules: ['RULE_CONN_001', 'RULE_CPU_001', 'RULE_QUERY_001'],
  },
  {
    name:        'query_inefficiency',
    description: 'RULE_QUERY_001 트리거 — queryTargeting=180 > 임계치(100)',
    metrics: {
      connections:      270,
      cpuNormalizedPct:  30,
      memoryUsedPct:     50,
      diskUsedGb:       125,
      diskQueueDepth:   1.0,
      readLatencyMs:      8,
      writeLatencyMs:    12,
      queryTargeting:   180,   // 임계치 100 초과, 150 이상 → medium
    },
    expectedRules:  ['RULE_QUERY_001'],
    forbiddenRules: ['RULE_CONN_001', 'RULE_CPU_001', 'RULE_DISK_001'],
  },
  {
    name:        'query_inefficiency_high',
    description: 'RULE_QUERY_001 high severity — queryTargeting=350 > 임계치(300)',
    metrics: {
      connections:      280,
      cpuNormalizedPct:  32,
      memoryUsedPct:     52,
      diskUsedGb:       130,
      diskQueueDepth:   1.1,
      readLatencyMs:      9,
      writeLatencyMs:    13,
      queryTargeting:   350,   // 300 초과 → high (풀스캔 수준)
    },
    expectedRules:  ['RULE_QUERY_001'],
    forbiddenRules: ['RULE_CONN_001', 'RULE_CPU_001', 'RULE_DISK_001'],
  },
]

// ── 룰 엔진 초기화 ────────────────────────────────────────────────

const engine = new RuleEngine([
  new ConnectionPressureRule(),
  new CpuSaturationRule(),
  new StorageBottleneckRule(),
  new QueryInefficiencyRule(),
])

// ── 검증 함수 ─────────────────────────────────────────────────────

function verifyScenario(scenario: Scenario, results: RuleResult[]): {
  passed: boolean
  errors: string[]
} {
  const errors: string[] = []
  const firedIds = results.map(r => r.ruleId)

  for (const ruleId of scenario.expectedRules) {
    if (!firedIds.includes(ruleId)) {
      errors.push(`MISSING: expected ${ruleId} to fire but it didn't`)
    }
  }
  for (const ruleId of scenario.forbiddenRules) {
    if (firedIds.includes(ruleId)) {
      errors.push(`UNEXPECTED: ${ruleId} fired but it shouldn't have`)
    }
  }

  return { passed: errors.length === 0, errors }
}

// ── 출력 헬퍼 ────────────────────────────────────────────────────

const GREEN  = '\x1b[32m'
const RED    = '\x1b[31m'
const YELLOW = '\x1b[33m'
const BOLD   = '\x1b[1m'
const RESET  = '\x1b[0m'

function pass(msg: string)  { console.log(`  ${GREEN}✓${RESET} ${msg}`) }
function fail(msg: string)  { console.log(`  ${RED}✗${RESET} ${msg}`) }
function info(msg: string)  { console.log(`  ${YELLOW}→${RESET} ${msg}`) }
function header(msg: string){ console.log(`\n${BOLD}${msg}${RESET}`) }

// ── 메인 ─────────────────────────────────────────────────────────

async function main() {
  console.log(`${BOLD}═══════════════════════════════════════════════════${RESET}`)
  console.log(`${BOLD}  Synthetic Metrics Seed & Rule Trigger Verification${RESET}`)
  console.log(`${BOLD}═══════════════════════════════════════════════════${RESET}`)
  console.log(`  cluster:    ${CLUSTER_NAME}`)
  console.log(`  db:         ${DB_NAME}`)
  console.log(`  points/scenario: ${POINTS_PER_SCENARIO}`)
  console.log(`  dry_run:    ${DRY_RUN}`)

  // MongoDB 연결
  let client: MongoClient | null = null
  let collection: ReturnType<ReturnType<typeof client.db>['collection']> | null = null

  if (MONGODB_URI && !DRY_RUN) {
    try {
      client = new MongoClient(MONGODB_URI)
      await client.connect()
      const db = client.db(DB_NAME)

      // atlas_metrics_ts 컬렉션이 없으면 생성
      const existing = await db.listCollections({ name: 'atlas_metrics_ts' }).toArray()
      if (existing.length === 0) {
        await db.createCollection('atlas_metrics_ts', {
          timeseries: {
            timeField: 'timestamp',
            metaField: 'meta',
            granularity: 'seconds',
          },
        })
        console.log(`\n  Created time-series collection: atlas_metrics_ts`)
      }

      collection = db.collection('atlas_metrics_ts')
      console.log(`  MongoDB: ${GREEN}connected${RESET}`)
    } catch (err) {
      console.log(`  MongoDB: ${RED}failed — ${(err as Error).message}${RESET}`)
      console.log(`  Continuing in dry-run mode...`)
      client = null
    }
  } else if (DRY_RUN) {
    console.log(`  MongoDB: ${YELLOW}skipped (dry_run=true)${RESET}`)
  } else {
    console.log(`  MongoDB: ${YELLOW}skipped (MONGODB_URI not set)${RESET}`)
  }

  // 전체 결과 집계
  let totalPassed = 0
  let totalFailed = 0
  const allFiredRuleIds = new Set<string>()

  for (const scenario of SCENARIOS) {
    header(`Scenario: ${scenario.name}`)
    console.log(`  ${scenario.description}`)

    // N개의 동일한 포인트 생성 (노이즈 없음 = 완전 결정론적)
    const now = new Date()
    const points: NormalizedMetrics[] = Array.from(
      { length: POINTS_PER_SCENARIO },
      (_, i) => ({
        ...scenario.metrics,
        // 각 포인트에 미세한 시각 차이 부여 (time-series 중복 방지)
        // 값 자체는 변경 없음
      }),
    )

    // 룰 평가
    const ruleInput: RuleInput = {
      clusterName: CLUSTER_NAME,
      windowStart: new Date(now.getTime() - 5 * 60 * 1000),
      windowEnd:   now,
      points,
    }
    const results = engine.evaluate(ruleInput)

    // 결과 출력
    if (results.length === 0) {
      info('No rules fired (expected for normal scenario)')
    } else {
      for (const r of results) {
        allFiredRuleIds.add(r.ruleId)
        info(`${r.ruleId} → ${r.type} [${r.severity}]`)
        info(`  summary: ${r.summary.slice(0, 80)}...`)
      }
    }

    // 검증
    const { passed, errors } = verifyScenario(scenario, results)
    if (passed) {
      pass(`Verification PASSED`)
      totalPassed++
    } else {
      for (const e of errors) fail(e)
      totalFailed++
    }

    // MongoDB insert (dry-run이 아닐 때)
    if (collection && !DRY_RUN) {
      const docs = points.map((metrics, i) => ({
        timestamp: new Date(now.getTime() - (POINTS_PER_SCENARIO - i) * 30 * 1000),
        meta: {
          projectId:   PROJECT_ID,
          clusterName: CLUSTER_NAME,
          source:      `seed:${scenario.name}`,
          metricGroup: 'system',
        },
        metrics,
      }))

      try {
        await collection.insertMany(docs)
        pass(`Inserted ${docs.length} documents → atlas_metrics_ts`)
      } catch (err) {
        fail(`Insert failed: ${(err as Error).message}`)
      }
    }
  }

  // ── 전체 요약 ──────────────────────────────────────────────────
  header('═══ Summary ═══')

  const ALL_RULE_IDS = ['RULE_CONN_001', 'RULE_CPU_001', 'RULE_DISK_001', 'RULE_QUERY_001']
  console.log('\n  4개 룰 트리거 여부:')
  for (const ruleId of ALL_RULE_IDS) {
    if (allFiredRuleIds.has(ruleId)) {
      pass(`${ruleId} — 최소 1회 트리거 확인`)
    } else {
      fail(`${ruleId} — 한 번도 트리거되지 않음`)
      totalFailed++
    }
  }

  console.log(`\n  시나리오 결과: ${GREEN}${totalPassed} passed${RESET} / ${totalFailed > 0 ? RED : ''}${totalFailed} failed${RESET}`)

  if (totalFailed > 0) {
    console.log(`\n${RED}  ✗ SEED VERIFICATION FAILED${RESET}`)
    process.exit(1)
  } else {
    console.log(`\n${GREEN}  ✓ SEED VERIFICATION PASSED — 모든 룰이 최소 1회 트리거됨${RESET}`)
  }

  if (client) {
    await client.close()
  }
}

main().catch(err => {
  console.error(RED + 'Fatal error:' + RESET, err)
  process.exit(1)
})

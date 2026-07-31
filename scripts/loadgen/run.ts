/**
 * loadgen/run.ts
 *
 * 지정한 시나리오의 합성 메트릭을 지속적으로 atlas_metrics_ts에 삽입한다.
 * Collector가 없는 환경에서 Detector 워커를 테스트할 때 사용한다.
 *
 * 사용법:
 *   MONGODB_URI=<uri> tsx scripts/loadgen/run.ts <scenario>
 *   pnpm --filter @demo/scripts loadgen:connection-surge
 *
 * 시나리오 목록:
 *   normal | connection_surge | cpu_saturation | storage_pressure | query_inefficiency
 */

import 'dotenv/config'
import { MongoClient } from 'mongodb'
import type { NormalizedMetrics } from '@demo/shared'

// ── 시나리오 → 메트릭 매핑 (노이즈 없는 고정값) ───────────────────

const SCENARIO_METRICS: Record<string, NormalizedMetrics> = {
  normal: {
    connections: 250, cpuNormalizedPct: 25, memoryUsedPct: 45,
    diskUsedGb: 120, diskQueueDepth: 0.8, readLatencyMs: 6,
    writeLatencyMs: 9, queryTargeting: 15,
  },
  connection_surge: {
    connections: 950, cpuNormalizedPct: 30, memoryUsedPct: 50,
    diskUsedGb: 130, diskQueueDepth: 1.0, readLatencyMs: 10,
    writeLatencyMs: 14, queryTargeting: 18,
  },
  cpu_saturation: {
    connections: 300, cpuNormalizedPct: 85, memoryUsedPct: 60,
    diskUsedGb: 130, diskQueueDepth: 1.2, readLatencyMs: 15,
    writeLatencyMs: 20, queryTargeting: 25,
  },
  storage_pressure: {
    connections: 280, cpuNormalizedPct: 32, memoryUsedPct: 55,
    diskUsedGb: 450, diskQueueDepth: 5.0, readLatencyMs: 55,
    writeLatencyMs: 70, queryTargeting: 20,
  },
  query_inefficiency: {
    connections: 270, cpuNormalizedPct: 30, memoryUsedPct: 50,
    diskUsedGb: 125, diskQueueDepth: 1.0, readLatencyMs: 8,
    writeLatencyMs: 12, queryTargeting: 180,
  },
}

// ── 설정 ──────────────────────────────────────────────────────────

const scenario    = process.argv[2] ?? 'normal'
const CLUSTER     = process.env.ATLAS_CLUSTER_NAME ?? 'perf-demo'
const PROJECT_ID  = process.env.ATLAS_PROJECT_ID   ?? 'demo-project'
const INTERVAL_MS = Number(process.env.LOADGEN_INTERVAL_MS ?? 5000)
const LIMIT       = Number(process.env.LOADGEN_LIMIT       ?? 0)   // 0 = 무제한

const metrics = SCENARIO_METRICS[scenario]
if (!metrics) {
  console.error(`Unknown scenario: '${scenario}'`)
  console.error(`Available: ${Object.keys(SCENARIO_METRICS).join(' | ')}`)
  process.exit(1)
}

const MONGODB_URI = process.env.MONGODB_URI ?? ''
if (!MONGODB_URI) {
  console.error('MONGODB_URI is required for loadgen')
  process.exit(1)
}

// ── 메인 ─────────────────────────────────────────────────────────

const client = new MongoClient(MONGODB_URI)
await client.connect()

const db  = client.db(process.env.MONGODB_DB_NAME ?? 'agentic_demo')
const col = db.collection('atlas_metrics_ts')

console.log(`[loadgen] scenario=${scenario} cluster=${CLUSTER} interval=${INTERVAL_MS}ms`)
console.log('[loadgen] Press Ctrl+C to stop\n')

let count = 0

async function insert() {
  const doc = {
    timestamp: new Date(),
    meta: {
      projectId:   PROJECT_ID,
      clusterName: CLUSTER,
      source:      `loadgen:${scenario}`,
      metricGroup: 'system',
    },
    metrics,
  }

  await col.insertOne(doc)
  count++
  console.log(`[loadgen] inserted #${count} | ${scenario} | ${new Date().toISOString()}`)

  if (LIMIT > 0 && count >= LIMIT) {
    console.log(`[loadgen] reached limit (${LIMIT}), stopping`)
    await client.close()
    process.exit(0)
  }
}

// 최초 즉시 실행 후 주기 반복
await insert()
const timer = setInterval(() => { insert().catch(console.error) }, INTERVAL_MS)

process.on('SIGINT',  async () => { clearInterval(timer); await client.close(); process.exit(0) })
process.on('SIGTERM', async () => { clearInterval(timer); await client.close(); process.exit(0) })

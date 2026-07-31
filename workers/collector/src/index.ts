import 'dotenv/config'
import { Agenda } from 'agenda'
import { MongoBackend } from '@agendajs/mongo-backend'
import { createAdapterFromEnv } from '@demo/atlas'
import { getDb, closeDb, ensureCollections } from '@demo/shared'
import { collectAndPersist } from './collect.js'
import {
  defaultRunMetrics,
  collectorRunFailuresTotal,
  collectorQueueDepth,
  startMetricsServer,
  startQueueDepthPoller,
} from './metrics.js'

// ── 설정 ──────────────────────────────────────────────────────────
const CLUSTER_NAME     = process.env.ATLAS_CLUSTER_NAME          ?? 'perf-demo'
const INTERVAL_SECONDS = Number(process.env.COLLECTOR_INTERVAL_SECONDS ?? 30)
const METRICS_PORT     = Number(process.env.COLLECTOR_METRICS_PORT     ?? 4010)

// ── 어댑터 초기화 ─────────────────────────────────────────────────
const adapter = createAdapterFromEnv()

// ── MongoDB 연결 (Agenda 백엔드로 사용 — 필수) ────────────────────
const db = await getDb().catch((err: unknown) => {
  console.error(`[collector] MongoDB connection failed: ${(err as Error).message}`)
  process.exit(1)
})
await ensureCollections(db)
console.log('[collector] MongoDB ready')

// ── Agenda 설정 ───────────────────────────────────────────────────
const agenda = new Agenda({
  backend:            new MongoBackend({ mongo: db }),
  processEvery:       '5 seconds',   // 잡 폴링 주기
  defaultConcurrency: 1,
  maxConcurrency:     1,
})

// ── 잡 핸들러 정의 ────────────────────────────────────────────────
agenda.define<{ clusterName: string }>('collect', async (job) => {
  const { clusterName } = job.attrs.data

  try {
    const res = await collectAndPersist({
      adapter,
      db,
      clusterName,
      prom: defaultRunMetrics,
    })

    const persistedMsg = res.inserted
      ? `→ inserted into atlas_metrics_ts`
      : `→ not persisted (no DB)`

    console.log(
      `[collector] ${res.source} | ${clusterName} | ` +
      `${res.durationMs}ms ${persistedMsg}`,
    )
  } catch (err) {
    collectorRunFailuresTotal.inc()
    console.error(`[collector] Failed for ${clusterName}:`, (err as Error).message)
    throw err   // Agenda 재시도 트리거
  }
})

agenda.on('success:collect', (job) => {
  console.log(`[collector] Job ${job.attrs._id} completed`)
})

// fail 이벤트: (error, job) 순서
agenda.on('fail:collect', (err, job) => {
  console.error(`[collector] Job ${job.attrs._id} failed: ${(err as Error).message}`)
})

// ── Graceful shutdown ─────────────────────────────────────────────
const shutdown = async (signal: string): Promise<void> => {
  console.log(`[collector] ${signal} received — shutting down`)
  await agenda.stop()
  await closeDb()
  process.exit(0)
}

process.on('SIGTERM', () => { void shutdown('SIGTERM') })
process.on('SIGINT',  () => { void shutdown('SIGINT')  })

// ── 메트릭 서버 + 스케줄 기동 ─────────────────────────────────────
startMetricsServer(METRICS_PORT, 'collector')
startQueueDepthPoller(db, 'collect', collectorQueueDepth)

await agenda.start()

/**
 * 반복 잡을 등록한다.
 * agenda.every()는 동일한 이름의 잡이 이미 존재하면 업데이트하므로
 * 재시작 시 중복 등록이 발생하지 않는다.
 */
await agenda.every(
  `${INTERVAL_SECONDS} seconds`,
  'collect',
  { clusterName: CLUSTER_NAME },
)

console.log(
  `[collector] Scheduled every ${INTERVAL_SECONDS}s → cluster: ${CLUSTER_NAME}`,
)
console.log('[collector] Worker started')

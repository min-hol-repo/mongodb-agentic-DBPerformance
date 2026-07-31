import 'dotenv/config'
import { Agenda } from 'agenda'
import { MongoBackend } from '@agendajs/mongo-backend'
import {
  getDb,
  closeDb,
  ensureCollections,
  findEventsByFilter,
} from '@demo/shared'
import { evaluateAndPersist } from './policy.js'
import {
  defaultRunMetrics,
  actuatorActionFailuresTotal,
  actuatorRunTotal,
  actuatorRunDuration,
  actuatorQueueDepth,
  startMetricsServer,
  startQueueDepthPoller,
} from './metrics.js'

// ── 설정 ──────────────────────────────────────────────────────────
const CLUSTER_NAME     = process.env.ATLAS_CLUSTER_NAME           ?? 'perf-demo'
const INTERVAL_SECONDS = 60
const METRICS_PORT     = Number(process.env.ACTUATOR_METRICS_PORT ?? 4012)

// ── MongoDB 연결 (Agenda 백엔드로 사용 — 필수) ────────────────────
const db = await getDb().catch((err: unknown) => {
  console.error(`[actuator] MongoDB connection failed: ${(err as Error).message}`)
  process.exit(1)
})
await ensureCollections(db)
console.log('[actuator] MongoDB ready')

// ── Agenda 설정 ───────────────────────────────────────────────────
const agenda = new Agenda({
  backend:            new MongoBackend({ mongo: db }),
  processEvery:       '5 seconds',
  defaultConcurrency: 1,
  maxConcurrency:     1,
})

// ── 잡 핸들러 정의 ────────────────────────────────────────────────
agenda.define<{ clusterName: string; triggeredBy?: string }>('evaluate', async (job) => {
  const { clusterName } = job.attrs.data

  actuatorRunTotal.inc()
  const durationEnd = actuatorRunDuration.startTimer()

  try {
    // 현재 open 병목 이벤트 조회
    const openEvents = await findEventsByFilter(db, clusterName, { status: 'open', limit: 20 })

    if (openEvents.length === 0) {
      console.log(`[actuator] ${clusterName}: no open events — skipping`)
      durationEnd()
      return
    }

    const result = await evaluateAndPersist({
      db,
      openEvents,
      prom: defaultRunMetrics,
    })

    durationEnd()

    const modeFromPolicy = result.createdActions[0]?.mode ?? 'dry_run'

    console.log(
      `[actuator] ${clusterName} | ` +
      `open=${openEvents.length} ` +
      `created=${result.actionsCreated} ` +
      `skipped=${result.actionsSkipped} ` +
      `mode=${modeFromPolicy}`,
    )

    if (result.skipReasons.length > 0) {
      for (const s of result.skipReasons) {
        console.log(`[actuator]   skip: ${s.eventType} / ${s.ruleId} → ${s.reason}`)
      }
    }
  } catch (err) {
    durationEnd()
    actuatorActionFailuresTotal.inc()
    console.error(`[actuator] Evaluation failed for ${clusterName}:`, (err as Error).message)
    throw err
  }
})

agenda.on('success:evaluate', (job) => {
  console.log(`[actuator] Job ${job.attrs._id} completed`)
})

// fail 이벤트: (error, job) 순서
agenda.on('fail:evaluate', (err, job) => {
  console.error(`[actuator] Job ${job.attrs._id} failed: ${(err as Error).message}`)
})

// ── Graceful shutdown ─────────────────────────────────────────────
const shutdown = async (signal: string): Promise<void> => {
  console.log(`[actuator] ${signal} received — shutting down`)
  await agenda.stop()
  await closeDb()
  process.exit(0)
}

process.on('SIGTERM', () => { void shutdown('SIGTERM') })
process.on('SIGINT',  () => { void shutdown('SIGINT')  })

// ── 메트릭 서버 + 스케줄 기동 ─────────────────────────────────────
startMetricsServer(METRICS_PORT, 'actuator')
startQueueDepthPoller(db, 'evaluate', actuatorQueueDepth)

await agenda.start()

/**
 * 반복 잡을 등록한다 (60초 기본 폴링).
 * detector가 즉시 트리거할 때는 detector 워커에서 agenda.now('evaluate', ...) 를 호출하며,
 * 같은 agendaJobs 컬렉션에 잡이 추가되면 이 actuator 인스턴스가 5초 이내에 처리한다.
 */
await agenda.every(
  `${INTERVAL_SECONDS} seconds`,
  'evaluate',
  { clusterName: CLUSTER_NAME },
)

console.log(`[actuator] Scheduled every ${INTERVAL_SECONDS}s → cluster: ${CLUSTER_NAME}`)
console.log('[actuator] Worker started')

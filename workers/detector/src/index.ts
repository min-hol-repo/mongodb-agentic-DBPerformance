import 'dotenv/config'
import { Agenda } from 'agenda'
import { MongoBackend } from '@agendajs/mongo-backend'
import {
  RuleEngine,
  ConnectionPressureRule,
  CpuSaturationRule,
  StorageBottleneckRule,
  QueryInefficiencyRule,
} from '@demo/rules'
import { getDb, closeDb, ensureCollections } from '@demo/shared'
import { detectAndPersist } from './detect.js'
import {
  defaultRunMetrics,
  detectorRunFailuresTotal,
  detectorQueueDepth,
  startMetricsServer,
  startQueueDepthPoller,
  setOpenEventsGauge,
} from './metrics.js'

// ── 설정 ──────────────────────────────────────────────────────────
const CLUSTER_NAME        = process.env.ATLAS_CLUSTER_NAME          ?? 'perf-demo'
const PROJECT_ID          = process.env.ATLAS_PROJECT_ID            ?? 'demo-project'
const RULE_WINDOW_MINUTES = Number(process.env.RULE_WINDOW_MINUTES  ?? 5)
const INTERVAL_SECONDS    = 60
const METRICS_PORT        = Number(process.env.DETECTOR_METRICS_PORT ?? 4011)

// ── 룰 엔진 초기화 ───────────────────────────────────────────────
const engine = new RuleEngine([
  new ConnectionPressureRule(),
  new CpuSaturationRule(),
  new StorageBottleneckRule(),
  new QueryInefficiencyRule(),
])

// ── MongoDB 연결 (Agenda 백엔드로 사용 — 필수) ────────────────────
const db = await getDb().catch((err: unknown) => {
  console.error(`[detector] MongoDB connection failed: ${(err as Error).message}`)
  process.exit(1)
})
await ensureCollections(db)
console.log('[detector] MongoDB ready')

// ── Agenda 설정 ───────────────────────────────────────────────────
const agenda = new Agenda({
  backend:            new MongoBackend({ mongo: db }),
  processEvery:       '5 seconds',
  defaultConcurrency: 1,
  maxConcurrency:     1,
})

// ── 잡 핸들러 정의 ────────────────────────────────────────────────
agenda.define<{ clusterName: string }>('detect', async (job) => {
  const { clusterName } = job.attrs.data

  try {
    const res = await detectAndPersist({
      db,
      clusterName,
      projectId:      PROJECT_ID,
      engine,
      windowMinutes:  RULE_WINDOW_MINUTES,
      prom:           defaultRunMetrics,
      minDataPoints:  1,
    })

    console.log(
      `[detector] ${clusterName} | points=${res.pointsFound} ` +
      `rules=${res.results.length} ` +
      `new=${res.eventsCreated} esc=${res.eventsEscalated} ` +
      `res=${res.eventsResolved} sup=${res.eventsSuppressed}`,
    )

    // open 이벤트 수 Gauge 업데이트
    const currentOpen = res.results.length + res.eventsCreated - res.eventsResolved
    setOpenEventsGauge(clusterName, Math.max(0, currentOpen))

    // ── 직접 트리거: 새 이벤트 또는 에스컬레이션 발생 시 ────────
    // actuator가 60초 폴링을 기다리지 않고 즉시 평가를 시작한다.
    // agenda.now()는 agendaJobs 컬렉션에 즉시 실행 잡을 추가하며,
    // actuator의 Agenda 인스턴스가 동일 컬렉션을 폴링하므로 자동으로 처리된다.
    if (res.eventsCreated > 0 || res.eventsEscalated > 0) {
      await agenda.now<{ clusterName: string; triggeredBy: string }>(
        'evaluate',
        { clusterName, triggeredBy: 'detector' },
      )
      console.log(
        `[detector] ⚡ Triggered actuator for ${clusterName} ` +
        `(new=${res.eventsCreated} esc=${res.eventsEscalated})`,
      )
    }
  } catch (err) {
    detectorRunFailuresTotal.inc()
    console.error(`[detector] Failed for ${clusterName}:`, (err as Error).message)
    throw err
  }
})

agenda.on('success:detect', (job) => {
  console.log(`[detector] Job ${job.attrs._id} completed`)
})

// fail 이벤트: (error, job) 순서
agenda.on('fail:detect', (err, job) => {
  console.error(`[detector] Job ${job.attrs._id} failed: ${(err as Error).message}`)
})

// ── Graceful shutdown ─────────────────────────────────────────────
const shutdown = async (signal: string): Promise<void> => {
  console.log(`[detector] ${signal} received — shutting down`)
  await agenda.stop()
  await closeDb()
  process.exit(0)
}

process.on('SIGTERM', () => { void shutdown('SIGTERM') })
process.on('SIGINT',  () => { void shutdown('SIGINT')  })

// ── 메트릭 서버 + 스케줄 기동 ─────────────────────────────────────
startMetricsServer(METRICS_PORT, 'detector')
startQueueDepthPoller(db, 'detect', detectorQueueDepth)

await agenda.start()

await agenda.every(
  `${INTERVAL_SECONDS} seconds`,
  'detect',
  { clusterName: CLUSTER_NAME },
)

console.log(`[detector] Scheduled every ${INTERVAL_SECONDS}s → cluster: ${CLUSTER_NAME}`)
console.log('[detector] Worker started')

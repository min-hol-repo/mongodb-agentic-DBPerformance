import 'dotenv/config'
import Fastify from 'fastify'
import cors from '@fastify/cors'
import { getDb, closeDb, ensureCollections, isConnected } from '@demo/shared'
import { setupHttpMetrics } from './plugins/http-metrics.js'
import { healthRoute } from './routes/health.js'
import { metricsRoute } from './routes/prometheus.js'
import { eventsRoute } from './routes/events.js'
import { actionsRoute } from './routes/actions.js'
import { policiesRoute } from './routes/policies.js'

const app = Fastify({ logger: true })

await app.register(cors, { origin: true })

// HTTP 요청 계측 (루트 인스턴스에 직접 등록 → 전역 적용)
setupHttpMetrics(app)

// ── MongoDB 연결 ────────────────────────────────────────────────
if (process.env.MONGODB_URI) {
  try {
    const db = await getDb()
    await ensureCollections(db)
  } catch (err) {
    app.log.warn(`MongoDB connection failed: ${(err as Error).message}`)
    app.log.warn('Starting without MongoDB. Some endpoints will return empty data.')
  }
} else {
  app.log.warn('MONGODB_URI not set – running without MongoDB')
}

// ── Routes ──────────────────────────────────────────────────────
await app.register(healthRoute)
await app.register(metricsRoute)
await app.register(eventsRoute)
await app.register(actionsRoute)
await app.register(policiesRoute)

// Still-placeholder routes (구현 예정)
app.get('/api/clusters', async () => ({ clusters: [] }))
app.get('/api/clusters/:clusterName/metrics', async (_req, reply) => {
  // Phase 3 구현 예정: time-series 쿼리
  reply.send({ metrics: [], note: 'Not yet implemented. Collector stores data; query to be wired.' })
})

// ── health 라우트에 DB 상태 반영 ─────────────────────────────────
app.decorate('dbConnected', () => isConnected())

// ── Graceful shutdown ────────────────────────────────────────────
const shutdown = async (signal: string) => {
  app.log.info(`Received ${signal}, shutting down...`)
  await app.close()
  await closeDb()
  process.exit(0)
}

process.on('SIGTERM', () => { void shutdown('SIGTERM') })
process.on('SIGINT',  () => { void shutdown('SIGINT') })

// ── 서버 기동 ────────────────────────────────────────────────────
const host = process.env.API_HOST ?? '0.0.0.0'
const port = Number(process.env.API_PORT ?? 4000)

try {
  await app.listen({ host, port })
  console.log(`API server running on http://${host}:${port}`)
} catch (err) {
  app.log.error(err)
  process.exit(1)
}

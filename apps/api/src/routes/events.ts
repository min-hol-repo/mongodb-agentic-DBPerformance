import type { FastifyInstance } from 'fastify'
import { getDb, isConnected, findEventsByFilter, findRecentEvents } from '@demo/shared'
import type { EventStatus, Severity, BottleneckType } from '@demo/shared'

export async function eventsRoute(app: FastifyInstance) {

  /**
   * GET /api/clusters/:clusterName/events
   *
   * bottleneck_events 컬렉션에서 이벤트를 조회한다.
   *
   * Query params (모두 선택):
   *   status   — open | resolved | suppressed
   *   severity — low | medium | high
   *   type     — connection_pressure | cpu_saturation | storage_bottleneck | query_inefficiency
   *   limit    — 반환 건수 (기본 50, 최대 200)
   *   since    — ISO8601 시각 이후 이벤트만
   *
   * 응답 필드 per event:
   *   _id, timestamp, clusterName, severity, type, ruleId,
   *   summary, recommendedActions, status, projectId, signals
   */
  app.get<{
    Params: { clusterName: string }
    Querystring: {
      status?:   string
      severity?: string
      type?:     string
      limit?:    string
      since?:    string
    }
  }>('/api/clusters/:clusterName/events', async (req, reply) => {
    const { clusterName } = req.params
    const { status, severity, type, limit, since } = req.query

    if (!isConnected()) {
      return reply.send({ clusterName, events: [], total: 0, note: 'MongoDB not connected' })
    }

    const db = await getDb()

    const events = await findEventsByFilter(db, clusterName, {
      status:   status   as EventStatus   | undefined,
      severity: severity as Severity      | undefined,
      type:     type     as BottleneckType | undefined,
      limit:    limit ? Math.min(Number(limit), 200) : 50,
      since:    since ? new Date(since) : undefined,
    })

    return reply.send({
      clusterName,
      events,
      total: events.length,
    })
  })

  /**
   * GET /api/clusters/:clusterName/events/open
   *
   * 현재 open 상태인 이벤트만 빠르게 조회한다.
   */
  app.get<{ Params: { clusterName: string } }>(
    '/api/clusters/:clusterName/events/open',
    async (req, reply) => {
      const { clusterName } = req.params

      if (!isConnected()) {
        return reply.send({ clusterName, events: [], total: 0 })
      }

      const db = await getDb()
      const events = await findEventsByFilter(db, clusterName, { status: 'open', limit: 100 })

      return reply.send({
        clusterName,
        events,
        total: events.length,
      })
    },
  )

  /**
   * POST /api/clusters/:clusterName/detect-now
   *
   * 즉시 탐지를 트리거한다.
   * detector 워커가 없거나 MongoDB가 없으면 rule-only 모드로 실행한다.
   *
   * Body (선택):
   *   windowMinutes — 탐지 윈도우 (기본 5분)
   */
  app.post<{
    Params: { clusterName: string }
    Body: { windowMinutes?: number }
  }>('/api/clusters/:clusterName/detect-now', async (req, reply) => {
    const { clusterName } = req.params
    const windowMinutes = req.body?.windowMinutes ?? 5

    if (!isConnected()) {
      return reply.status(503).send({
        error: 'MongoDB not connected',
        hint: 'Set MONGODB_URI and restart the API server',
      })
    }

    try {
      const db = await getDb()

      // 최근 이벤트 수 반환 (실제 탐지는 detector 워커가 담당)
      const recentEvents = await findRecentEvents(db, clusterName, 10)
      const openCount    = recentEvents.filter(e => e.status === 'open').length

      return reply.send({
        clusterName,
        windowMinutes,
        message:         'Detection is handled by the detector worker. Returning current event state.',
        recentEventCount: recentEvents.length,
        openEventCount:   openCount,
        events:           recentEvents,
      })
    } catch (err) {
      return reply.status(500).send({ error: (err as Error).message })
    }
  })
}

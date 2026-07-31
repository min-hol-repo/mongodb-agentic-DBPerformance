import type { FastifyInstance } from 'fastify'
import { Counter, Gauge, Histogram, collectDefaultMetrics } from 'prom-client'

// FastifyRequest에 타이밍 필드 추가
declare module 'fastify' {
  interface FastifyRequest {
    metricsStartTime: bigint
  }
}

// ── HTTP 요청 카운터 + 히스토그램 ─────────────────────────────────

export const httpRequestsTotal = new Counter({
  name:       'api_http_requests_total',
  help:       'Total number of HTTP requests',
  labelNames: ['method', 'route', 'status_code'] as const,
})

export const httpRequestDuration = new Histogram({
  name:       'api_http_request_duration_seconds',
  help:       'HTTP request duration in seconds',
  labelNames: ['method', 'route', 'status_code'] as const,
  buckets:    [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
})

// ── 현재 처리 중인 요청 수 (in-flight) ───────────────────────────

export const httpRequestsInFlight = new Gauge({
  name: 'api_http_requests_in_flight',
  help: 'Number of HTTP requests currently being processed',
})

// ── 4xx / 5xx 에러 전용 카운터 ───────────────────────────────────
// api_http_requests_total{status_code=~"4..|5.."} 로도 계산 가능하지만
// 별도 카운터로 노출하면 알림 규칙 작성이 더 단순해진다.

export const httpErrorsTotal = new Counter({
  name:       'api_http_errors_total',
  help:       'Total number of HTTP 4xx and 5xx responses',
  labelNames: ['method', 'route', 'status_code'] as const,
})

collectDefaultMetrics({ prefix: 'api_' })

/**
 * setupHttpMetrics
 * app 인스턴스에 직접 hooks를 등록해 전역 적용한다.
 */
export function setupHttpMetrics(app: FastifyInstance): void {
  app.decorateRequest('metricsStartTime', 0n)

  app.addHook('onRequest', async (req) => {
    req.metricsStartTime = process.hrtime.bigint()
    // /metrics 엔드포인트는 계측 제외
    if (req.url !== '/metrics') {
      httpRequestsInFlight.inc()
    }
  })

  app.addHook('onResponse', async (req, reply) => {
    if (req.url === '/metrics') return

    const route      = req.routeOptions?.url ?? req.url
    const method     = req.method
    const statusCode = String(reply.statusCode)
    const durationSec = Number(process.hrtime.bigint() - req.metricsStartTime) / 1e9

    httpRequestsInFlight.dec()
    httpRequestsTotal.inc({ method, route, status_code: statusCode })
    httpRequestDuration.observe({ method, route, status_code: statusCode }, durationSec)

    // 4xx / 5xx 에러 카운터
    if (reply.statusCode >= 400) {
      httpErrorsTotal.inc({ method, route, status_code: statusCode })
    }
  })
}

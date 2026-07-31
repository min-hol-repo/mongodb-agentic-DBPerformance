import type { FastifyInstance } from 'fastify'
import { register } from 'prom-client'

export async function metricsRoute(app: FastifyInstance) {
  app.get('/metrics', async (_req, reply) => {
    reply.header('Content-Type', register.contentType)
    return reply.send(await register.metrics())
  })
}

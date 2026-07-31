import type { FastifyInstance } from 'fastify'
import { isConnected } from '@demo/shared'

const startTime = Date.now()

export async function healthRoute(app: FastifyInstance) {
  app.get('/api/health', async (_req, reply) => {
    return reply.send({
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: Math.floor((Date.now() - startTime) / 1000),
      version: process.env.npm_package_version ?? '0.1.0',
      service: 'api',
      db: isConnected() ? 'connected' : 'disconnected',
    })
  })
}

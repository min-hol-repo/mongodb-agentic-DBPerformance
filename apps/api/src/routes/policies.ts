import type { FastifyInstance } from 'fastify'
import { getDb, isConnected, findOrCreatePolicy, upsertPolicy } from '@demo/shared'
import type { ActuatorMode, ActionType } from '@demo/shared'

// 유효한 값 목록
const VALID_MODES:   ActuatorMode[] = ['dry_run', 'approval_required', 'auto_execute']
const VALID_ACTIONS: ActionType[]   = ['scale_recommendation', 'scale_up_request', 'notify_only']
const VALID_TIERS = ['M10', 'M20', 'M30', 'M40', 'M50', 'M60', 'M80', 'M140', 'M200', 'M300', 'M400']

export async function policiesRoute(app: FastifyInstance) {

  /**
   * GET /api/policies/:clusterName
   *
   * 클러스터 정책을 반환한다. 없으면 기본값(dry_run, M60, 30min)으로 생성 후 반환.
   *
   * 응답 필드:
   *   clusterName, mode, maxTier, cooldownMinutes,
   *   allowActions, blockedActions, updatedAt
   */
  app.get<{ Params: { clusterName: string } }>(
    '/api/policies/:clusterName',
    async (req, reply) => {
      const { clusterName } = req.params

      if (!isConnected()) {
        // DB 없을 때 기본 정책 반환 (읽기 전용)
        return reply.send({
          clusterName,
          mode:            'dry_run',
          maxTier:         'M60',
          cooldownMinutes: 30,
          allowActions:    ['scale_recommendation', 'scale_up_request', 'notify_only'],
          blockedActions:  [],
          updatedAt:       new Date().toISOString(),
          note:            'MongoDB not connected — default policy',
        })
      }

      const db = await getDb()
      const policy = await findOrCreatePolicy(db, clusterName)

      return reply.send(policy)
    },
  )

  /**
   * PATCH /api/policies/:clusterName
   *
   * 클러스터 정책을 부분 업데이트(upsert)한다.
   *
   * Body (모두 선택):
   *   mode           — dry_run | approval_required  (auto_execute MVP에서 거부)
   *   maxTier        — M10 ~ M400
   *   cooldownMinutes — 0 ~ 1440
   *   allowActions   — ActionType[]
   *   blockedActions — ActionType[]
   */
  app.patch<{
    Params: { clusterName: string }
    Body: Partial<{
      mode:            ActuatorMode
      maxTier:         string
      cooldownMinutes: number
      allowActions:    ActionType[]
      blockedActions:  ActionType[]
    }>
  }>(
    '/api/policies/:clusterName',
    async (req, reply) => {
      const { clusterName } = req.params
      const body = req.body ?? {}

      if (!isConnected()) {
        return reply.status(503).send({ error: 'MongoDB not connected' })
      }

      // ── 유효성 검사 ────────────────────────────────────────────
      if (body.mode !== undefined) {
        if (!VALID_MODES.includes(body.mode)) {
          return reply.status(400).send({ error: `Invalid mode: ${body.mode}` })
        }
        if (body.mode === 'auto_execute') {
          return reply.status(400).send({
            error: 'auto_execute is disabled in this MVP. Use dry_run or approval_required.',
          })
        }
      }

      if (body.maxTier !== undefined && !VALID_TIERS.includes(body.maxTier)) {
        return reply.status(400).send({ error: `Invalid maxTier: ${body.maxTier}. Valid: ${VALID_TIERS.join(', ')}` })
      }

      if (body.cooldownMinutes !== undefined) {
        const n = Number(body.cooldownMinutes)
        if (!Number.isInteger(n) || n < 0 || n > 1440) {
          return reply.status(400).send({ error: 'cooldownMinutes must be 0–1440' })
        }
      }

      if (body.allowActions !== undefined) {
        const invalid = body.allowActions.filter(a => !VALID_ACTIONS.includes(a))
        if (invalid.length > 0) {
          return reply.status(400).send({ error: `Invalid allowActions: ${invalid.join(', ')}` })
        }
      }

      if (body.blockedActions !== undefined) {
        const invalid = body.blockedActions.filter(a => !VALID_ACTIONS.includes(a))
        if (invalid.length > 0) {
          return reply.status(400).send({ error: `Invalid blockedActions: ${invalid.join(', ')}` })
        }
      }

      // ── 저장 ──────────────────────────────────────────────────
      const db = await getDb()
      const existing = await findOrCreatePolicy(db, clusterName)

      const updated = {
        ...existing,
        ...(body.mode            !== undefined && { mode:            body.mode }),
        ...(body.maxTier         !== undefined && { maxTier:         body.maxTier }),
        ...(body.cooldownMinutes !== undefined && { cooldownMinutes: body.cooldownMinutes }),
        ...(body.allowActions    !== undefined && { allowActions:    body.allowActions }),
        ...(body.blockedActions  !== undefined && { blockedActions:  body.blockedActions }),
        updatedAt: new Date(),
      }

      await upsertPolicy(db, updated)

      return reply.send(updated)
    },
  )
}

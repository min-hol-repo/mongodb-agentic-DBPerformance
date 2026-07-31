import type { FastifyInstance } from 'fastify'
import {
  getDb,
  isConnected,
  findRecentActions,
  findPendingActions,
  findActionById,
  recordTransition,
} from '@demo/shared'
import { isTransitionAllowed } from '@demo/shared'

export async function actionsRoute(app: FastifyInstance) {

  // ── 조회 ─────────────────────────────────────────────────────────

  /**
   * GET /api/clusters/:clusterName/actions
   *
   * actuator_actions 컬렉션에서 액션 목록을 조회한다.
   *
   * 저장 필드 per action:
   *   timestamp, clusterName, actionType, mode, reason, ruleId,
   *   beforeState, proposedState, result, cooldownUntil,
   *   approvedAt, rejectedAt, auditLog[]
   *
   * Query params (모두 선택):
   *   result — pending | approved | rejected | executed | not_executed
   *   limit  — 반환 건수 (기본 20, 최대 100)
   */
  app.get<{
    Params:      { clusterName: string }
    Querystring: { result?: string; limit?: string }
  }>('/api/clusters/:clusterName/actions', async (req, reply) => {
    const { clusterName } = req.params
    const { result, limit } = req.query

    if (!isConnected()) {
      return reply.send({ clusterName, actions: [], total: 0, note: 'MongoDB not connected' })
    }

    const db  = await getDb()
    const cap = limit ? Math.min(Number(limit), 100) : 20

    let actions
    if (result === 'pending') {
      actions = await findPendingActions(db, clusterName)
    } else {
      actions = await findRecentActions(db, clusterName, cap)
      if (result) actions = actions.filter(a => a.result === result)
    }

    return reply.send({ clusterName, actions, total: actions.length })
  })

  /**
   * GET /api/actions/:actionId
   *
   * 단일 액션을 ID로 조회한다. auditLog 포함.
   */
  app.get<{ Params: { actionId: string } }>(
    '/api/actions/:actionId',
    async (req, reply) => {
      const { actionId } = req.params

      if (!isConnected()) {
        return reply.status(503).send({ error: 'MongoDB not connected' })
      }

      const db     = await getDb()
      const action = await findActionById(db, actionId)

      if (!action) {
        return reply.status(404).send({ error: 'Action not found' })
      }

      return reply.send(action)
    },
  )

  // ── 상태 전이 ─────────────────────────────────────────────────────

  /**
   * POST /api/actions/:actionId/approve
   *
   * pending 상태의 액션을 승인한다.
   *
   * 상태 전이: pending → approved
   * 기록:      result='approved', approvedAt=now, auditLog에 전이 항목 추가
   *
   * 오류:
   *   404 — 액션을 찾을 수 없음
   *   409 — pending 상태가 아님 (이미 처리됨)
   */
  app.post<{ Params: { actionId: string } }>(
    '/api/actions/:actionId/approve',
    async (req, reply) => {
      const { actionId } = req.params

      if (!isConnected()) {
        return reply.status(503).send({ error: 'MongoDB not connected' })
      }

      const db     = await getDb()
      const action = await findActionById(db, actionId)

      if (!action) {
        return reply.status(404).send({ error: 'Action not found' })
      }

      // 상태 전이 허용 여부 확인
      if (!isTransitionAllowed(action.result, 'approved')) {
        return reply.status(409).send({
          error:   'Transition not allowed',
          current: action.result,
          attempted: 'approved',
          message: `Action is '${action.result}' — only 'pending' actions can be approved`,
        })
      }

      const updated = await recordTransition(db, actionId, {
        from:  'pending',
        to:    'approved',
        actor: 'operator',
      })

      if (!updated) {
        // 낙관적 잠금 실패 (동시 변경)
        return reply.status(409).send({
          error:   'Concurrent modification detected',
          message: 'The action was modified by another request. Please refresh and retry.',
        })
      }

      return reply.send({
        ...updated,
        message: 'Action approved successfully',
      })
    },
  )

  /**
   * POST /api/actions/:actionId/reject
   *
   * pending 상태의 액션을 거절한다.
   *
   * 상태 전이: pending → rejected
   * 기록:      result='rejected', rejectedAt=now, auditLog에 전이 항목 추가 (note 포함)
   *
   * Body (선택):
   *   reason — 거절 사유 (auditLog.note에 기록)
   *
   * 오류:
   *   404 — 액션을 찾을 수 없음
   *   409 — pending 상태가 아님 (이미 처리됨)
   */
  app.post<{
    Params: { actionId: string }
    Body:   { reason?: string }
  }>(
    '/api/actions/:actionId/reject',
    async (req, reply) => {
      const { actionId } = req.params
      const reason = req.body?.reason

      if (!isConnected()) {
        return reply.status(503).send({ error: 'MongoDB not connected' })
      }

      const db     = await getDb()
      const action = await findActionById(db, actionId)

      if (!action) {
        return reply.status(404).send({ error: 'Action not found' })
      }

      if (!isTransitionAllowed(action.result, 'rejected')) {
        return reply.status(409).send({
          error:     'Transition not allowed',
          current:   action.result,
          attempted: 'rejected',
          message:   `Action is '${action.result}' — only 'pending' actions can be rejected`,
        })
      }

      const updated = await recordTransition(db, actionId, {
        from:  'pending',
        to:    'rejected',
        actor: 'operator',
        note:  reason,
      })

      if (!updated) {
        return reply.status(409).send({
          error:   'Concurrent modification detected',
          message: 'The action was modified by another request. Please refresh and retry.',
        })
      }

      return reply.send({
        ...updated,
        message: 'Action rejected',
      })
    },
  )
}

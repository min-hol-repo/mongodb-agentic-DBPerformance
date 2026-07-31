export type ActuatorMode   = 'dry_run' | 'approval_required' | 'auto_execute'
export type ActionType     = 'scale_recommendation' | 'scale_up_request' | 'notify_only'
export type ActionStatus   = 'pending' | 'approved' | 'rejected' | 'executed' | 'not_executed'

// ── 상태 전이 규칙 (명시적 상태 머신) ────────────────────────────
//
// 허용된 전이:
//   pending → approved   (운영자 승인)
//   pending → rejected   (운영자 거절)
//
// 금지된 전이 (이미 완료된 상태):
//   approved → *         (한 번 승인되면 변경 불가)
//   rejected → *         (한 번 거절되면 변경 불가)
//   not_executed → *     (dry-run 결과는 변경 불가)
//   executed → *         (실행 완료는 변경 불가)

export const ALLOWED_TRANSITIONS: Partial<Record<ActionStatus, readonly ActionStatus[]>> = {
  pending: ['approved', 'rejected'] as const,
}

export function isTransitionAllowed(from: ActionStatus, to: ActionStatus): boolean {
  return ALLOWED_TRANSITIONS[from]?.includes(to) ?? false
}

// ── 감사 로그 항목 ────────────────────────────────────────────────

export interface AuditEntry {
  /** 전이 발생 시각 */
  at:         Date
  /** 이전 상태 */
  from:       ActionStatus
  /** 새 상태 */
  to:         ActionStatus
  /** 행위자 식별 ('operator' = 사람, 'system' = 자동) */
  actor:      'operator' | 'system'
  /** 거절 사유 등 선택적 메모 */
  note?:      string
}

// ── ActuatorAction ────────────────────────────────────────────────

export interface ActuatorAction {
  timestamp:     Date
  clusterName:   string
  actionType:    ActionType
  mode:          ActuatorMode
  reason:        string
  ruleId?:       string
  beforeState?:  Record<string, unknown>
  proposedState?: Record<string, unknown>
  result:        ActionStatus
  cooldownUntil?: Date
  /** 최종 승인 시각 (approved 상태일 때) */
  approvedAt?:   Date
  /** 최종 거절 시각 (rejected 상태일 때) */
  rejectedAt?:   Date
  /**
   * 감사 로그 — 상태 전이 이력을 불변 형태로 보관한다.
   * $push 연산으로만 추가되며 항목을 삭제하거나 수정하지 않는다.
   */
  auditLog?:     AuditEntry[]
}

// ── ActuatorPolicy ────────────────────────────────────────────────

export interface ActuatorPolicy {
  clusterName:     string
  mode:            ActuatorMode
  maxTier:         string
  cooldownMinutes: number
  allowActions:    ActionType[]
  blockedActions:  ActionType[]
  updatedAt:       Date
}

import type { Db } from '@demo/shared'
import {
  insertAction,
  findLastActionByType,
  findPendingActions,
  findOrCreatePolicy,
  type ActionWithId,
} from '@demo/shared'
import type {
  ActuatorAction,
  ActuatorMode,
  ActuatorPolicy,
  ActionType,
} from '@demo/shared'
import type { BottleneckEvent, BottleneckType, Severity, EventWithId } from '@demo/shared'
import type { ActuatorRunMetrics } from './metrics.js'

// ── 상수 ─────────────────────────────────────────────────────────

/** 티어 순서 (오름차순). scale_up 시 다음 티어 계산에 사용 */
const TIER_ORDER = [
  'M10', 'M20', 'M30', 'M40', 'M50',
  'M60', 'M80', 'M140', 'M200', 'M300', 'M400',
] as const

/** 파괴적 액션 — 정책과 무관하게 항상 차단 */
const ALWAYS_BLOCKED: readonly ActionType[] = [] as const

/** scale_down은 MVP에서 항상 차단 */
const SCALE_DOWN_TYPES = ['scale_down'] as const

// ── 병목 유형 → 액션 타입 명시적 규칙 테이블 ─────────────────────
//
// 이 테이블이 detector 출력과 actuator 추천을 연결하는 핵심 규칙이다.
//
// 규칙 1: query_inefficiency → 항상 notify_only (추천 전용)
//   - queryTargeting 높음 = 인덱스 미사용 / 비효율 쿼리 원인
//   - scale 증설로 근본 원인 해결 불가
//   - 인덱스 생성 · 쿼리 재작성을 먼저 시도해야 함
//   - scale 제안은 절대 금지 (모든 severity에서)
//
// 규칙 2: connection_pressure → 보수적 scale 제안 가능
//   - low/medium: connection pool 설정 검토가 우선
//     → scale_recommendation (권고만, 실행 안 함)
//   - high: 연결 수가 임계치를 크게 초과한 경우
//     → scale_up_request (승인 대기 또는 dry_run 기록)
//   - 어느 경우에도 자동 실행 없음 (cooldown + guardrail 적용)
//
// 규칙 3: cpu_saturation → scale 제안 (쿼리 개선 병행)
//   - CPU 상승 원인이 비효율 쿼리일 수 있으므로
//     query_inefficiency가 동시 firing 시 RuleEngine이
//     'consider_scale_up'을 'review_query_efficiency_first'로 교체
//
// 규칙 4: storage_bottleneck → scale 제안 (항상 high severity)
//   - 디스크 I/O 병목은 capacity 문제이므로 scale 권고
//
// 공통 원칙:
//   - 모든 액션은 result='not_executed'(dry_run) 또는 'pending'(approval_required)
//   - auto_execute 모드는 MVP 비활성 → dry_run fallback
//   - 어떤 액션도 자동으로 실행(auto-executed)되어서는 안 됨

export const BOTTLENECK_ACTION_MAP: Readonly<
  Record<BottleneckType, Record<Severity, ActionType>>
> = {
  // query_inefficiency: 모든 severity에서 notify_only만 허용
  query_inefficiency: {
    low:    'notify_only',
    medium: 'notify_only',
    high:   'notify_only',
  },
  // connection_pressure: 보수적 — low/medium은 권고, high만 요청
  connection_pressure: {
    low:    'scale_recommendation',
    medium: 'scale_recommendation',
    high:   'scale_up_request',
  },
  // cpu_saturation: query_inefficiency 동시 firing 시 engine이 scale 교체
  cpu_saturation: {
    low:    'scale_recommendation',
    medium: 'scale_recommendation',
    high:   'scale_up_request',
  },
  // storage_bottleneck: 항상 high severity이므로 즉각 scale 요청
  storage_bottleneck: {
    low:    'scale_up_request',
    medium: 'scale_up_request',
    high:   'scale_up_request',
  },
} as const

// ── 타입 ─────────────────────────────────────────────────────────

export interface SkipReason {
  eventId:   string
  eventType: string
  ruleId:    string
  reason:    string
}

export interface EvaluateAndPersistOptions {
  db:              Db | null
  openEvents:      EventWithId[]
  prom:            ActuatorRunMetrics
  /** 테스트용: DB 조회 없이 정책 직접 주입 */
  injectedPolicy?: ActuatorPolicy
}

export interface PolicyEvalResult {
  clusterName:    string
  actionsCreated: number
  actionsSkipped: number
  skipReasons:    SkipReason[]
  createdActions: ActionWithId[]
}

// ── 내부 헬퍼 ─────────────────────────────────────────────────────

function tierIndex(tier: string): number {
  return TIER_ORDER.indexOf(tier as (typeof TIER_ORDER)[number])
}

function nextTier(current: string): string | null {
  const idx = tierIndex(current)
  if (idx === -1 || idx >= TIER_ORDER.length - 1) return null
  return TIER_ORDER[idx + 1]
}

/**
 * BOTTLENECK_ACTION_MAP을 참조해 병목 유형 + severity → ActionType을 결정한다.
 * 매핑이 없는 경우 fallback: scale_recommendation
 */
function determineActionType(
  eventType: BottleneckEvent['type'],
  severity:  BottleneckEvent['severity'],
): ActionType {
  return BOTTLENECK_ACTION_MAP[eventType]?.[severity] ?? 'scale_recommendation'
}

/**
 * 쿨다운 만료 시각을 계산한다.
 */
function cooldownUntil(from: Date, minutes: number): Date {
  return new Date(from.getTime() + minutes * 60 * 1000)
}

// ── 핵심 정책 엔진 ────────────────────────────────────────────────

/**
 * 현재 open 병목 이벤트를 평가하고, 정책에 따라 액션을 생성/저장한다.
 *
 * 흐름:
 *   1. 정책 로드 (DB 조회 또는 주입)
 *   2. 각 open 이벤트에 대해:
 *      a. actionType 결정 (병목 유형 + severity 기반)
 *      b. Guardrail 검사 (순서대로):
 *         - scale_down 하드코딩 차단
 *         - allowActions 목록에 없으면 skip
 *         - blockedActions 목록에 있으면 skip
 *         - 이미 같은 actionType pending 중이면 skip (중복 방지)
 *         - cooldown 내 동일 actionType이면 skip
 *         - scale 액션이고 이미 maxTier면 skip
 *      c. 모드에 따라 액션 생성:
 *         - dry_run:           result = 'not_executed'
 *         - approval_required: result = 'pending'
 *         - auto_execute:      MVP에서 dry_run과 동일
 *   3. 메트릭 업데이트
 *
 * 설계 원칙:
 *   - db = null 이면 policy 체크/저장 없이 시뮬레이션 결과만 반환
 *   - 모든 guardrail 위반은 skipReasons에 상세 기록
 *   - 파괴적 작업(destructive operations)은 절대 허용 안 함
 */
export async function evaluateAndPersist(
  opts: EvaluateAndPersistOptions,
): Promise<PolicyEvalResult> {
  const { db, openEvents, prom, injectedPolicy } = opts

  if (openEvents.length === 0) {
    return {
      clusterName:    '',
      actionsCreated: 0,
      actionsSkipped: 0,
      skipReasons:    [],
      createdActions: [],
    }
  }

  const clusterName = openEvents[0].clusterName
  const now = new Date()

  // 1. 정책 로드
  const policy: ActuatorPolicy =
    injectedPolicy ??
    (db ? await findOrCreatePolicy(db, clusterName) : {
      clusterName,
      mode:           'dry_run',
      maxTier:        'M60',
      cooldownMinutes: 30,
      allowActions:   ['scale_recommendation', 'scale_up_request', 'notify_only'],
      blockedActions: [],
      updatedAt:      now,
    })

  // auto_execute는 MVP에서 dry_run으로 fallback
  const effectiveMode: ActuatorMode =
    policy.mode === 'auto_execute' ? 'dry_run' : policy.mode

  if (policy.mode === 'auto_execute') {
    console.log(`[actuator] auto_execute is disabled in MVP — falling back to dry_run`)
  }

  // 2. 현재 pending 액션 목록 (중복 방지에 사용)
  const pendingActions = db ? await findPendingActions(db, clusterName) : []
  const pendingTypes   = new Set(pendingActions.map(a => a.actionType))

  const skipReasons:    SkipReason[]  = []
  const createdActions: ActionWithId[] = []
  let actionsCreated = 0
  let actionsSkipped = 0

  // 3. 각 open 이벤트 평가
  for (const event of openEvents) {
    const actionType = determineActionType(event.type, event.severity)

    const skip = (reason: string): void => {
      skipReasons.push({ eventId: event._id, eventType: event.type, ruleId: event.ruleId, reason })
      actionsSkipped++
      prom.actionsSkipped.inc({ reason: reason.split(':')[0] ?? 'unknown' })
    }

    // ── Guardrail A: scale_down 하드코딩 차단 ──────────────────
    if ((SCALE_DOWN_TYPES as readonly string[]).includes(actionType) ||
        (ALWAYS_BLOCKED as readonly string[]).includes(actionType)) {
      skip('blocked:destructive_operation')
      continue
    }

    // ── Guardrail B: allowActions 목록 확인 ───────────────────
    if (!policy.allowActions.includes(actionType)) {
      skip(`blocked:not_in_allow_list (${actionType})`)
      continue
    }

    // ── Guardrail C: blockedActions 목록 확인 ─────────────────
    if (policy.blockedActions.includes(actionType)) {
      skip(`blocked:in_blocked_list (${actionType})`)
      continue
    }

    // ── Guardrail D: 중복 pending 액션 방지 ───────────────────
    if (pendingTypes.has(actionType)) {
      skip(`suppressed:pending_exists (${actionType})`)
      continue
    }

    // ── Guardrail E: cooldown 체크 ────────────────────────────
    if (db) {
      const lastAction = await findLastActionByType(db, clusterName, actionType)
      if (lastAction) {
        const cooldownExpiry = new Date(
          new Date(lastAction.timestamp).getTime() + policy.cooldownMinutes * 60 * 1000,
        )
        if (now < cooldownExpiry) {
          const remainingMins = Math.ceil((cooldownExpiry.getTime() - now.getTime()) / 60000)
          skip(`suppressed:in_cooldown (${remainingMins}min remaining)`)
          continue
        }
      }
    }

    // ── Guardrail F: max tier 확인 (scale 액션만) ─────────────
    const isScaleAction = actionType === 'scale_up_request' || actionType === 'scale_recommendation'
    const proposedTierStr = isScaleAction ? nextTier(policy.maxTier) ?? policy.maxTier : null

    if (isScaleAction) {
      const maxTierIdx  = tierIndex(policy.maxTier)
      // 현재 maxTier가 이미 TIER_ORDER 최상위면 scale 불가
      if (maxTierIdx === TIER_ORDER.length - 1) {
        skip(`blocked:already_at_max_tier (${policy.maxTier})`)
        continue
      }
    }

    // ── 액션 생성 ─────────────────────────────────────────────
    const result = effectiveMode === 'approval_required' ? 'pending' : 'not_executed'

    const action: ActuatorAction = {
      timestamp:     now,
      clusterName,
      actionType,
      mode:          effectiveMode,
      reason:        `${event.ruleId}: ${event.type} (${event.severity})`,
      ruleId:        event.ruleId,
      beforeState:   isScaleAction ? { tier: policy.maxTier, note: 'current_tier_from_policy' } : undefined,
      proposedState: isScaleAction && proposedTierStr
        ? { tier: proposedTierStr }
        : { note: `${actionType} — ${event.summary.slice(0, 60)}` },
      result,
      cooldownUntil: cooldownUntil(now, policy.cooldownMinutes),
    }

    if (db) {
      const id = await insertAction(db, action)
      const actionWithId: ActionWithId = { ...action, _id: id }
      createdActions.push(actionWithId)
      pendingTypes.add(actionType)   // 이번 사이클 내 중복 방지
    }

    actionsCreated++
    prom.actionsTotal.inc({ action_type: actionType, mode: effectiveMode })

    console.log(
      `[actuator] ${effectiveMode.toUpperCase()}  ${actionType} | ${event.type} (${event.severity}) | ${clusterName}`,
    )
  }

  return {
    clusterName,
    actionsCreated,
    actionsSkipped,
    skipReasons,
    createdActions,
  }
}

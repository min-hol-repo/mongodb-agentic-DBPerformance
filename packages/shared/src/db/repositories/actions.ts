import { ObjectId, type Db, type Document } from 'mongodb'
import type {
  ActuatorAction,
  ActionType,
  ActionStatus,
  AuditEntry,
} from '../../types/actions.js'
import { COLLECTIONS } from '../collection-names.js'

const COLLECTION = COLLECTIONS.ACTIONS

// ── 공통 타입 ─────────────────────────────────────────────────────

export type ActionWithId = ActuatorAction & { _id: string }

function toActionWithId(raw: ActuatorAction & { _id: ObjectId }): ActionWithId {
  const { _id, ...rest } = raw
  return { ...rest, _id: _id.toString() }
}

// ── 레포지토리 ────────────────────────────────────────────────────

/**
 * 액추에이터 액션을 삽입하고 _id를 반환한다.
 */
export async function insertAction(
  db: Db,
  action: ActuatorAction,
): Promise<string> {
  const result = await db
    .collection<ActuatorAction>(COLLECTION)
    .insertOne({ ...action, auditLog: [] })
  return result.insertedId.toString()
}

/**
 * _id로 단일 액션을 조회한다. 없으면 null.
 */
export async function findActionById(
  db: Db,
  id: string,
): Promise<ActionWithId | null> {
  if (!ObjectId.isValid(id)) return null
  const doc = await db
    .collection<ActuatorAction>(COLLECTION)
    .findOne({ _id: new ObjectId(id) })
  return doc ? toActionWithId(doc) : null
}

/**
 * 클러스터의 최근 액션을 최신순으로 반환한다. 기본 20건.
 */
export async function findRecentActions(
  db: Db,
  clusterName: string,
  limit = 20,
): Promise<ActionWithId[]> {
  const docs = await db
    .collection<ActuatorAction>(COLLECTION)
    .find({ clusterName }, { sort: { timestamp: -1 }, limit })
    .toArray()
  return docs.map((doc) => toActionWithId(doc))
}

/**
 * 특정 클러스터 + actionType의 가장 최근 액션을 반환한다.
 * cooldown 체크에 사용한다.
 */
export async function findLastActionByType(
  db: Db,
  clusterName: string,
  actionType: ActionType,
): Promise<ActionWithId | null> {
  const doc = await db
    .collection<ActuatorAction>(COLLECTION)
    .findOne({ clusterName, actionType }, { sort: { timestamp: -1 } })
  return doc ? toActionWithId(doc) : null
}

/**
 * 클러스터의 pending 상태 액션 목록을 반환한다.
 */
export async function findPendingActions(
  db: Db,
  clusterName: string,
): Promise<ActionWithId[]> {
  const docs = await db
    .collection<ActuatorAction>(COLLECTION)
    .find({ clusterName, result: 'pending' }, { sort: { timestamp: -1 } })
    .toArray()
  return docs.map((doc) => toActionWithId(doc))
}

/**
 * 액션 상태를 업데이트한다 (approve / reject 등).
 * 하위 호환성을 위해 유지하되 내부적으로 recordTransition을 호출한다.
 */
export async function updateActionStatus(
  db: Db,
  id: string,
  status: ActionStatus,
  extra: { approvedAt?: Date; rejectedAt?: Date } = {},
): Promise<void> {
  // 현재 상태 조회 (감사 로그용)
  const existing = await findActionById(db, id)
  const from = existing?.result ?? 'pending'

  const entry: AuditEntry = {
    at:    extra.approvedAt ?? extra.rejectedAt ?? new Date(),
    from:  from as ActionStatus,
    to:    status,
    actor: 'operator',
  }

  // MongoDB driver의 $push 타입이 배열 원소 타입을 정확히 추론하지 못하므로
  // 업데이트 연산 전체를 Document로 캐스팅한다 (as never보다 의미 명확).
  const update: Document = {
    $set:  { result: status, ...extra },
    $push: { auditLog: entry },
  }
  await db
    .collection<ActuatorAction>(COLLECTION)
    .updateOne({ _id: new ObjectId(id) }, update)
}

/**
 * 상태 전이를 원자적으로 기록한다.
 * - `result` 필드를 새 상태로 변경
 * - `auditLog` 배열에 전이 항목을 추가 ($push — 덮어쓰지 않음)
 * - `approvedAt` / `rejectedAt` 시각 기록
 *
 * 이 함수는 감사 추적에 안전하다:
 *   - 기존 auditLog 항목은 절대 삭제되거나 수정되지 않는다
 *   - 같은 액션에 여러 번 호출해도 이력이 누적만 된다
 */
export async function recordTransition(
  db: Db,
  id: string,
  opts: {
    from:   ActionStatus
    to:     ActionStatus
    actor:  AuditEntry['actor']
    note?:  string
    now?:   Date
  },
): Promise<ActionWithId | null> {
  const at = opts.now ?? new Date()

  const entry: AuditEntry = {
    at,
    from:  opts.from,
    to:    opts.to,
    actor: opts.actor,
    ...(opts.note ? { note: opts.note } : {}),
  }

  // 상태별 시각 필드
  const timestampField =
    opts.to === 'approved' ? { approvedAt: at } :
    opts.to === 'rejected' ? { rejectedAt: at } :
    {}

  const update: Document = {
    $set:  { result: opts.to, ...timestampField },
    $push: { auditLog: entry },
  }

  const updateResult = await db
    .collection<ActuatorAction>(COLLECTION)
    .findOneAndUpdate(
      {
        _id:    new ObjectId(id),
        result: opts.from,   // 낙관적 잠금: 현재 상태가 from이어야만 업데이트
      },
      update,
      { returnDocument: 'after' },
    )

  return updateResult ? toActionWithId(updateResult) : null
}

import { ObjectId, type Db, type Filter } from 'mongodb'
import type {
  BottleneckEvent,
  BottleneckType,
  EventStatus,
  Severity,
} from '../../types/events.js'
import { COLLECTIONS } from '../collection-names.js'

const COLLECTION = COLLECTIONS.EVENTS

// ── 공통 타입 ─────────────────────────────────────────────────────

export type EventWithId = BottleneckEvent & { _id: string }

export interface EventFilter {
  status?:   EventStatus | EventStatus[]
  severity?: Severity    | Severity[]
  type?:     BottleneckType | BottleneckType[]
  limit?:    number
  since?:    Date
}

function toEventWithId(raw: BottleneckEvent & { _id: ObjectId }): EventWithId {
  const { _id, ...rest } = raw
  return { ...rest, _id: _id.toString() }
}

// ── 레포지토리 ────────────────────────────────────────────────────

/**
 * 병목 이벤트를 삽입하고 삽입된 문서의 _id를 반환한다.
 *
 * 저장 필드:
 *   timestamp, clusterName, severity, type, ruleId,
 *   summary, recommendedActions, status, projectId, signals
 */
export async function insertEvent(
  db: Db,
  event: BottleneckEvent,
): Promise<string> {
  // 스프레드로 복사 → insertOne이 _id를 원본 객체에 추가하지 않도록 방어
  const result = await db
    .collection<BottleneckEvent>(COLLECTION)
    .insertOne({ ...event })
  return result.insertedId.toString()
}

/**
 * 클러스터의 최근 이벤트를 최신순으로 반환한다. 기본 20건.
 */
export async function findRecentEvents(
  db: Db,
  clusterName: string,
  limit = 20,
): Promise<EventWithId[]> {
  const docs = await db
    .collection<BottleneckEvent>(COLLECTION)
    .find({ clusterName }, { sort: { timestamp: -1 }, limit })
    .toArray()
  return docs.map((doc) => toEventWithId(doc))
}

/**
 * 클러스터의 이벤트를 필터 조건으로 조회한다.
 *
 * 지원 필터:
 *   status   — 'open' | 'resolved' | 'suppressed' (단일 또는 배열)
 *   severity — 'low' | 'medium' | 'high' (단일 또는 배열)
 *   type     — BottleneckType (단일 또는 배열)
 *   limit    — 반환 최대 건수 (기본 50)
 *   since    — 이 시각 이후 이벤트만 반환
 */
export async function findEventsByFilter(
  db: Db,
  clusterName: string,
  filter: EventFilter = {},
): Promise<EventWithId[]> {
  const { status, severity, type, limit = 50, since } = filter

  const query: Filter<BottleneckEvent> = { clusterName }

  if (status !== undefined) {
    query.status = Array.isArray(status) ? { $in: status } : status
  }
  if (severity !== undefined) {
    query.severity = Array.isArray(severity) ? { $in: severity } : severity
  }
  if (type !== undefined) {
    query.type = Array.isArray(type) ? { $in: type } : type
  }
  if (since !== undefined) {
    query.timestamp = { $gte: since }
  }

  const docs = await db
    .collection<BottleneckEvent>(COLLECTION)
    .find(query, { sort: { timestamp: -1 }, limit })
    .toArray()

  return docs.map((doc) => toEventWithId(doc))
}

/**
 * 특정 클러스터 + 타입의 열린(open) 이벤트를 반환한다.
 * 중복 억제(duplicate suppression)에 사용한다.
 */
export async function findOpenEventByType(
  db: Db,
  clusterName: string,
  type: BottleneckType,
): Promise<EventWithId | null> {
  const doc = await db
    .collection<BottleneckEvent>(COLLECTION)
    .findOne({ clusterName, type, status: 'open' }, { sort: { timestamp: -1 } })
  return doc ? toEventWithId(doc) : null
}

/**
 * 이벤트의 상태를 업데이트한다.
 */
export async function updateEventStatus(
  db: Db,
  id: string,
  status: EventStatus,
): Promise<void> {
  await db
    .collection<BottleneckEvent>(COLLECTION)
    .updateOne(
      { _id: new ObjectId(id) },
      { $set: { status } },
    )
}

/**
 * 기존 open 이벤트의 severity를 상향(에스컬레이션)한다.
 * 원래 timestamp는 유지하고 severity·summary·signals만 갱신한다.
 */
export async function escalateEvent(
  db: Db,
  id: string,
  severity: Severity,
  summary: string,
  signals?: Record<string, number>,
): Promise<void> {
  await db
    .collection<BottleneckEvent>(COLLECTION)
    .updateOne(
      { _id: new ObjectId(id) },
      {
        $set: {
          severity,
          summary,
          ...(signals !== undefined ? { signals } : {}),
        },
      },
    )
}

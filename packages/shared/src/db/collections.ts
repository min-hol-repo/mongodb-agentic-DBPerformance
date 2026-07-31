import type { Db } from 'mongodb'
import type { BottleneckEvent } from '../types/events.js'
import type { ActuatorAction, ActuatorPolicy } from '../types/actions.js'
import { COLLECTIONS } from './collection-names.js'

/**
 * 필요한 컬렉션이 없으면 생성하고 인덱스를 설정한다.
 * 멱등적으로 동작하므로 서버 기동 시마다 호출해도 안전하다.
 */
export async function ensureCollections(db: Db): Promise<void> {
  const existing = await db.listCollections().toArray()
  const names = new Set(existing.map((c) => c.name))

  // ── atlas_metrics_ts : time-series ────────────────────────────
  if (!names.has(COLLECTIONS.METRICS)) {
    await db.createCollection(COLLECTIONS.METRICS, {
      timeseries: {
        timeField: 'timestamp',   // Date 필드
        metaField: 'meta',        // { projectId, clusterName, source, metricGroup }
        granularity: 'seconds',
      },
    })
    console.log(`[db] Created time-series collection: ${COLLECTIONS.METRICS}`)
  }

  // ── bottleneck_events ─────────────────────────────────────────
  if (!names.has(COLLECTIONS.EVENTS)) {
    await db.createCollection(COLLECTIONS.EVENTS)
    const col = db.collection<BottleneckEvent>(COLLECTIONS.EVENTS)
    // 클러스터별 최신 이벤트 조회 + 중복 억제 쿼리 최적화
    await col.createIndex({ clusterName: 1, type: 1, status: 1, timestamp: -1 })
    // 시간순 전체 조회
    await col.createIndex({ timestamp: -1 })
    console.log(`[db] Created collection: ${COLLECTIONS.EVENTS}`)
  }

  // ── actuator_actions ──────────────────────────────────────────
  if (!names.has(COLLECTIONS.ACTIONS)) {
    await db.createCollection(COLLECTIONS.ACTIONS)
    const col = db.collection<ActuatorAction>(COLLECTIONS.ACTIONS)
    await col.createIndex({ clusterName: 1, timestamp: -1 })
    // approval flow: pending 상태 조회
    await col.createIndex({ clusterName: 1, result: 1, timestamp: -1 })
    // cooldown 체크: 최근 동일 actionType 조회
    await col.createIndex({ clusterName: 1, actionType: 1, timestamp: -1 })
    console.log(`[db] Created collection: ${COLLECTIONS.ACTIONS}`)
  }

  // ── actuator_policies ─────────────────────────────────────────
  if (!names.has(COLLECTIONS.POLICIES)) {
    await db.createCollection(COLLECTIONS.POLICIES)
    await db.collection<ActuatorPolicy>(COLLECTIONS.POLICIES).createIndex(
      { clusterName: 1 },
      { unique: true },
    )
    console.log(`[db] Created collection: ${COLLECTIONS.POLICIES}`)
  }
}

import type { Db } from 'mongodb'
import type { ActuatorPolicy } from '../../types/actions.js'
import { COLLECTIONS } from '../collection-names.js'

const COLLECTION = COLLECTIONS.POLICIES

// ── 기본 정책 ─────────────────────────────────────────────────────

export function defaultPolicy(clusterName: string): ActuatorPolicy {
  return {
    clusterName,
    mode: 'dry_run',
    maxTier: 'M60',
    cooldownMinutes: 30,
    allowActions: ['scale_recommendation', 'scale_up_request', 'notify_only'],
    blockedActions: [],           // scale_down은 명시적으로 추가해야 허용
    updatedAt: new Date(),
  }
}

// ── 레포지토리 ────────────────────────────────────────────────────

/**
 * 정책을 저장하거나 갱신한다 (upsert).
 * clusterName 기준으로 upsert하므로 중복이 없다.
 */
export async function upsertPolicy(
  db: Db,
  policy: ActuatorPolicy,
): Promise<void> {
  await db.collection<ActuatorPolicy>(COLLECTION).updateOne(
    { clusterName: policy.clusterName },
    { $set: { ...policy, updatedAt: new Date() } },
    { upsert: true },
  )
}

/**
 * 클러스터의 정책을 반환한다.
 * 없으면 기본 정책을 DB에 삽입 후 반환한다.
 */
export async function findOrCreatePolicy(
  db: Db,
  clusterName: string,
): Promise<ActuatorPolicy> {
  const existing = await db
    .collection<ActuatorPolicy>(COLLECTION)
    .findOne({ clusterName })

  if (existing) {
    const { _id: _omit, ...policy } = existing as ActuatorPolicy & { _id: unknown }
    return policy
  }

  const policy = defaultPolicy(clusterName)
  await upsertPolicy(db, policy)
  return policy
}

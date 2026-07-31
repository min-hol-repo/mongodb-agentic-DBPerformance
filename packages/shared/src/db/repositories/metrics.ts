import type { Db } from 'mongodb'
import type { MetricsDocument, NormalizedMetrics } from '../../types/metrics.js'
import { COLLECTIONS } from '../collection-names.js'

const COLLECTION = COLLECTIONS.METRICS

// ── 입력 타입 ─────────────────────────────────────────────────────

export interface InsertMetricsInput {
  clusterName: string
  projectId: string
  source: string
  metrics: NormalizedMetrics
  timestamp?: Date   // 생략 시 현재 시각
}

// ── 레포지토리 ────────────────────────────────────────────────────

/**
 * 메트릭 문서를 time-series 컬렉션에 삽입한다.
 */
export async function insertMetrics(
  db: Db,
  input: InsertMetricsInput,
): Promise<void> {
  const doc: MetricsDocument = {
    timestamp: input.timestamp ?? new Date(),
    meta: {
      projectId: input.projectId,
      clusterName: input.clusterName,
      source: input.source,
      metricGroup: 'system',
    },
    metrics: input.metrics,
  }
  await db.collection<MetricsDocument>(COLLECTION).insertOne(doc)
}

/**
 * 최근 N분 이내의 메트릭을 시간 오름차순으로 반환한다.
 */
export async function queryRecentMetrics(
  db: Db,
  clusterName: string,
  windowMinutes: number,
): Promise<MetricsDocument[]> {
  const since = new Date(Date.now() - windowMinutes * 60 * 1000)
  return db
    .collection<MetricsDocument>(COLLECTION)
    .find(
      { 'meta.clusterName': clusterName, timestamp: { $gte: since } },
      { sort: { timestamp: 1 } },
    )
    .toArray()
}

/**
 * 지정 시간 범위의 메트릭을 반환한다.
 */
export async function queryMetricsRange(
  db: Db,
  clusterName: string,
  from: Date,
  to: Date,
): Promise<MetricsDocument[]> {
  return db
    .collection<MetricsDocument>(COLLECTION)
    .find(
      { 'meta.clusterName': clusterName, timestamp: { $gte: from, $lte: to } },
      { sort: { timestamp: 1 } },
    )
    .toArray()
}

/**
 * 가장 최근 메트릭 1건을 반환한다. 없으면 null.
 */
export async function queryLatestMetrics(
  db: Db,
  clusterName: string,
): Promise<MetricsDocument | null> {
  return db
    .collection<MetricsDocument>(COLLECTION)
    .findOne(
      { 'meta.clusterName': clusterName },
      { sort: { timestamp: -1 } },
    )
}

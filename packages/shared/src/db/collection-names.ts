/**
 * MongoDB 컬렉션 이름 상수
 *
 * 이 파일이 유일한 진실의 원천(single source of truth)이다.
 * 컬렉션 이름을 직접 문자열로 쓰지 말고 이 상수를 import한다.
 */

export const COLLECTIONS = {
  METRICS:   'atlas_metrics_ts',
  EVENTS:    'bottleneck_events',
  ACTIONS:   'actuator_actions',
  POLICIES:  'actuator_policies',
} as const

export type CollectionName = typeof COLLECTIONS[keyof typeof COLLECTIONS]

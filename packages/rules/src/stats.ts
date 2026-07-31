import type { NormalizedMetrics } from '@demo/shared'

/**
 * 주어진 필드의 평균값을 계산한다.
 * points가 비어있으면 0을 반환한다.
 */
export function avg(
  points: NormalizedMetrics[],
  field: keyof NormalizedMetrics,
): number {
  if (points.length === 0) return 0
  return points.reduce((sum, p) => sum + p[field], 0) / points.length
}

/**
 * 주어진 필드의 최댓값을 반환한다.
 * points가 비어있으면 0을 반환한다.
 */
export function max(
  points: NormalizedMetrics[],
  field: keyof NormalizedMetrics,
): number {
  if (points.length === 0) return 0
  return Math.max(...points.map(p => p[field]))
}

/**
 * 추세를 계산한다. (마지막 절반 평균 - 처음 절반 평균)
 * 양수 = 상승 추세, 음수 = 하락 추세, 0 = 변화 없음
 * points가 2개 미만이면 0을 반환한다.
 */
export function trend(
  points: NormalizedMetrics[],
  field: keyof NormalizedMetrics,
): number {
  if (points.length < 2) return 0
  const mid   = Math.floor(points.length / 2)
  const first = points.slice(0, mid)
  const last  = points.slice(mid)
  return avg(last, field) - avg(first, field)
}

/**
 * 주어진 필드 기준으로 임계치를 초과하는 points의 비율을 반환한다. (0–1)
 * 예: 0.8 = 80%의 points가 임계치를 초과
 */
export function exceedanceRatio(
  points: NormalizedMetrics[],
  field: keyof NormalizedMetrics,
  threshold: number,
): number {
  if (points.length === 0) return 0
  const exceeded = points.filter(p => p[field] > threshold).length
  return exceeded / points.length
}

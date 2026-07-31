import type { BottleneckRule, RuleInput, RuleResult } from './types.js'
import type { Severity } from '@demo/shared'

const SEVERITY_RANK: Record<Severity, number> = { low: 1, medium: 2, high: 3 }

/**
 * query_inefficiency 동시 감지 시 다른 룰의 스케일 권고를 교체하는 액션 키.
 * "scale이 도움될 수 있지만 쿼리/인덱스 개선을 먼저 시도하라"는 의미.
 */
export const QUERY_FIRST_ACTION = 'review_query_efficiency_first' as const

export class RuleEngine {
  private readonly rules: BottleneckRule[]

  constructor(rules: BottleneckRule[]) {
    this.rules = rules
  }

  /**
   * 모든 룰을 평가하고 firing된 결과 목록을 반환한다.
   *
   * 처리 순서:
   *   1. 각 룰의 minPoints 요건을 사전 검사 (미달 시 skip)
   *   2. evaluate() 호출
   *   3. 교차 룰 우선순위 적용:
   *      query_inefficiency가 firing되면 다른 룰의 'consider_scale_up' 을
   *      'review_query_efficiency_first' 로 교체한다.
   *      → 스케일 가능성을 완전히 지우지 않고, 쿼리 개선이 우선임을 명시.
   *   4. severity 내림차순 정렬 (high → medium → low)
   */
  evaluate(input: RuleInput): RuleResult[] {
    const results: RuleResult[] = []

    for (const rule of this.rules) {
      if (input.points.length < rule.minPoints) continue
      const result = rule.evaluate(input)
      if (result !== null) results.push(result)
    }

    // 교차 룰 우선순위 적용
    const hasQueryInefficiency = results.some(r => r.type === 'query_inefficiency')
    if (hasQueryInefficiency) {
      for (const r of results) {
        if (r.type === 'query_inefficiency') continue

        const scaleIdx = r.recommendedActions.indexOf('consider_scale_up')
        if (scaleIdx !== -1) {
          // 제거가 아닌 교체 — 운영자에게 scale이 여전히 옵션임을 알리되 우선순위를 낮춤
          r.recommendedActions = [
            ...r.recommendedActions.slice(0, scaleIdx),
            QUERY_FIRST_ACTION,
            ...r.recommendedActions.slice(scaleIdx + 1),
          ]
        }
      }
    }

    // severity 내림차순 정렬
    results.sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity])

    return results
  }
}

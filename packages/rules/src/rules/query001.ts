import type { BottleneckRule, RuleInput, RuleResult } from '../types.js'
import { avg, max, trend, exceedanceRatio } from '../stats.js'

// ── 임계치 ────────────────────────────────────────────────────────
const QUERY_TARGETING_LOW    = 100   // low severity 트리거 (반환 1건당 스캔 100건)
const QUERY_TARGETING_MEDIUM = 150   // medium severity 트리거
const QUERY_TARGETING_HIGH   = 300   // high severity 트리거

/**
 * RULE_QUERY_001: Query Inefficiency
 *
 * queryTargeting = 반환된 문서 1건당 스캔된 문서 수.
 * 값이 높을수록 인덱스 미사용 또는 비효율적 쿼리임을 의미한다.
 *
 * 트리거 조건:
 *   - 윈도우 내 평균 queryTargeting ≥ QUERY_TARGETING_LOW
 *
 * Severity 산정:
 *   - queryTargeting ≥ 300 → high   (풀스캔 수준)
 *   - queryTargeting ≥ 150 → medium (인덱스 부분 사용)
 *   - queryTargeting ≥ 100 → low    (인덱스 개선 여지 있음)
 *
 * 스케일 권고 정책:
 *   - 이 룰에서는 절대 scale 권고 없음.
 *   - 쿼리/인덱스 개선이 CPU·연결·스토리지 부하를 동시에 줄일 수 있음.
 *   - RuleEngine이 이 룰 firing 시 다른 룰의 'consider_scale_up' 을
 *     'review_query_efficiency_first' 로 교체한다.
 */
export class QueryInefficiencyRule implements BottleneckRule {
  readonly id        = 'RULE_QUERY_001'
  readonly type      = 'query_inefficiency' as const
  readonly minPoints = 3

  evaluate(input: RuleInput): RuleResult | null {
    const avgTargeting   = avg(input.points, 'queryTargeting')
    const maxTargeting   = max(input.points, 'queryTargeting')
    const targetingTrend = trend(input.points, 'queryTargeting')
    const ratio          = exceedanceRatio(input.points, 'queryTargeting', QUERY_TARGETING_LOW)

    if (avgTargeting < QUERY_TARGETING_LOW) return null

    let severity: RuleResult['severity']
    if (avgTargeting >= QUERY_TARGETING_HIGH) {
      severity = 'high'
    } else if (avgTargeting >= QUERY_TARGETING_MEDIUM) {
      severity = 'medium'
    } else {
      severity = 'low'
    }

    // severity별 더 구체적인 summary
    const trendNote  = targetingTrend > 20 ? ' (worsening trend)' : targetingTrend < -20 ? ' (improving)' : ''
    const severityContext: Record<typeof severity, string> = {
      high:   `Severe index absence or full collection scan detected${trendNote}. `,
      medium: `Indexes are only partially being used${trendNote}. `,
      low:    `There is room to improve index efficiency${trendNote}. `,
    }

    return {
      ruleId:  this.id,
      type:    this.type,
      severity,
      summary: `Average query targeting ratio ${avgTargeting.toFixed(0)} (max ${maxTargeting.toFixed(0)}) is high. ` +
               severityContext[severity] +
               `Review indexes and query plans before considering resource scaling.`,
      // scale 권고 의도적 제외 — 절대 포함하지 않음
      recommendedActions: [
        'review_indexes',
        'analyze_slow_queries',
        'run_explain_plan',
        'add_missing_indexes',
        'rewrite_inefficient_queries',
      ],
      signals: {
        avgQueryTargeting:   Math.round(avgTargeting),
        maxQueryTargeting:   Math.round(maxTargeting),
        queryTargetingTrend: Math.round(targetingTrend),
        exceedanceRatio:     Math.round(ratio * 100) / 100,
        threshold:           QUERY_TARGETING_LOW,
      },
    }
  }
}

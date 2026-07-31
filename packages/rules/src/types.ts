import type { NormalizedMetrics, Severity, BottleneckType } from '@demo/shared'

export interface RuleInput {
  clusterName: string
  windowStart: Date
  windowEnd:   Date
  points:      NormalizedMetrics[]
}

export interface RuleResult {
  ruleId:             string
  type:               BottleneckType
  severity:           Severity
  summary:            string
  recommendedActions: string[]
  signals:            Record<string, number>
}

export interface BottleneckRule {
  readonly id:        string
  readonly type:      BottleneckType
  /**
   * 이 룰이 평가를 수행하기 위한 최소 데이터 포인트 수.
   * RuleEngine이 사전 검사하므로 각 룰 구현체는 별도 검사 불필요.
   */
  readonly minPoints: number
  evaluate(input: RuleInput): RuleResult | null
}

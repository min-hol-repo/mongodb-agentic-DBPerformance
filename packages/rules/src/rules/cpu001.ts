import type { BottleneckRule, RuleInput, RuleResult } from '../types.js'
import { avg, max } from '../stats.js'

// ── 임계치 ────────────────────────────────────────────────────────
const CPU_HIGH        = 70   // medium severity 트리거
const CPU_CRITICAL    = 90   // high severity 트리거
const LATENCY_HIGH_MS = 30   // CPU + latency 동반 상승 시 severity 상향

/**
 * RULE_CPU_001: CPU Saturation
 *
 * 트리거 조건:
 *   - 윈도우 내 평균 cpuNormalizedPct ≥ CPU_HIGH
 *
 * Severity 산정:
 *   - cpu ≥ 90                      → high
 *   - cpu ≥ 70 AND latency ≥ 30ms   → high (실질적 포화)
 *   - cpu ≥ 70                       → medium
 *
 * 스케일 권고 정책 (보수적):
 *   - medium: 쿼리 플랜·인덱스 검토 먼저. scale 없음.
 *             CPU 상승의 상당 비율이 비효율적 쿼리에서 비롯되므로.
 *   - high:   쿼리 검토 후에도 지속되면 scale 고려 (항상 마지막 항목).
 */
export class CpuSaturationRule implements BottleneckRule {
  readonly id        = 'RULE_CPU_001'
  readonly type      = 'cpu_saturation' as const
  readonly minPoints = 3

  evaluate(input: RuleInput): RuleResult | null {
    const avgCpu     = avg(input.points, 'cpuNormalizedPct')
    const avgLatency = avg(input.points, 'readLatencyMs')
    const maxCpu     = max(input.points, 'cpuNormalizedPct')

    if (avgCpu < CPU_HIGH) return null

    let severity: RuleResult['severity']
    if (avgCpu >= CPU_CRITICAL) {
      severity = 'high'
    } else if (avgLatency >= LATENCY_HIGH_MS) {
      severity = 'high'
    } else {
      severity = 'medium'
    }

    // 쿼리 검토 항목을 항상 scale보다 앞에 배치
    // high severity에서만 scale 포함, 항상 마지막
    const recommendedActions =
      severity === 'high'
        ? ['review_query_plans', 'check_indexes', 'optimize_aggregations', 'consider_scale_up']
        : ['review_query_plans', 'check_indexes', 'optimize_aggregations']

    return {
      ruleId:  this.id,
      type:    this.type,
      severity,
      summary: `Average CPU usage ${avgCpu.toFixed(1)}% (max ${maxCpu.toFixed(1)}%) exceeded threshold (${CPU_HIGH}%). ` +
               `Inefficient queries may be the cause — review query plans first.`,
      recommendedActions,
      signals: {
        avgCpuPct:        Math.round(avgCpu * 10) / 10,
        maxCpuPct:        Math.round(maxCpu * 10) / 10,
        avgReadLatencyMs: Math.round(avgLatency * 10) / 10,
        threshold:        CPU_HIGH,
      },
    }
  }
}

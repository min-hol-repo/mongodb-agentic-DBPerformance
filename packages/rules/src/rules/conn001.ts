import type { BottleneckRule, RuleInput, RuleResult } from '../types.js'
import { avg, trend } from '../stats.js'

// ── 임계치 ────────────────────────────────────────────────────────
const CONNECTIONS_HIGH     = 800   // low severity 트리거
const CONNECTIONS_MEDIUM   = 900   // medium severity 트리거
const CONNECTIONS_CRITICAL = 1200  // high severity 트리거
const LATENCY_HIGH_MS      = 20    // latency도 높으면 severity 상향

/**
 * RULE_CONN_001: Connection Pressure
 *
 * 트리거 조건:
 *   - 윈도우 내 평균 connections ≥ CONNECTIONS_HIGH
 *
 * Severity 산정:
 *   - connections ≥ 1200          → high
 *   - connections ≥ 900 AND latency ≥ 20ms → high
 *   - connections ≥ 900            → medium
 *   - connections ≥ 800            → low
 *
 * 스케일 권고 정책 (보수적):
 *   - low / medium: connection pooling · 설정 최적화만 권고, scale 없음
 *   - high: 위 조치 후에도 개선 안 되면 scale 고려 (마지막 수단)
 */
export class ConnectionPressureRule implements BottleneckRule {
  readonly id        = 'RULE_CONN_001'
  readonly type      = 'connection_pressure' as const
  readonly minPoints = 3

  evaluate(input: RuleInput): RuleResult | null {
    const avgConn    = avg(input.points, 'connections')
    const avgLatency = avg(input.points, 'readLatencyMs')
    const connTrend  = trend(input.points, 'connections')

    if (avgConn < CONNECTIONS_HIGH) return null

    let severity: RuleResult['severity']
    if (avgConn >= CONNECTIONS_CRITICAL) {
      severity = 'high'
    } else if (avgConn >= CONNECTIONS_MEDIUM && avgLatency >= LATENCY_HIGH_MS) {
      severity = 'high'
    } else if (avgConn >= CONNECTIONS_MEDIUM) {
      severity = 'medium'
    } else {
      severity = 'low'
    }

    const trendNote = connTrend > 50 ? ' (rising trend)' : ''

    // 보수적 스케일 권고: high severity일 때만 포함, 항상 마지막
    const recommendedActions =
      severity === 'high'
        ? ['check_connection_pooling', 'review_max_pool_size', 'check_query_patterns', 'consider_scale_up']
        : ['check_connection_pooling', 'review_max_pool_size', 'check_query_patterns']

    return {
      ruleId:  this.id,
      type:    this.type,
      severity,
      summary: `Average connections ${avgConn.toFixed(0)}${trendNote} exceeded threshold (${CONNECTIONS_HIGH}). ` +
               `Check connection pool settings first.`,
      recommendedActions,
      signals: {
        avgConnections:   Math.round(avgConn),
        avgReadLatencyMs: Math.round(avgLatency * 10) / 10,
        connectionTrend:  Math.round(connTrend),
        threshold:        CONNECTIONS_HIGH,
      },
    }
  }
}

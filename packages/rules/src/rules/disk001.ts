import type { BottleneckRule, RuleInput, RuleResult } from '../types.js'
import { avg } from '../stats.js'

// ── 임계치 ────────────────────────────────────────────────────────
const DISK_QUEUE_HIGH     = 3.0   // 트리거 조건
const DISK_QUEUE_CRITICAL = 6.0   // 즉각 주의 메시지 추가
const MEMORY_HIGH_PCT     = 80    // 메모리 고사용률 (스토리지 압박 간접 지표)

/**
 * RULE_DISK_001: Storage Bottleneck
 *
 * 트리거 조건 (OR):
 *   - 윈도우 내 평균 diskQueueDepth ≥ DISK_QUEUE_HIGH
 *   - 윈도우 내 평균 memoryUsedPct  ≥ MEMORY_HIGH_PCT
 *
 * Severity:
 *   - 항상 high (가이드: storage bottleneck = 항상 high)
 *
 * 스케일 권고 정책 (보수적):
 *   - diskQueueDepth 트리거: 슬로우 쿼리 확인 후 스토리지 티어 검토, 마지막에 scale
 *   - 메모리만 트리거: 비효율 쿼리가 원인일 가능성이 높음 → scale 권고 없음
 *   - 둘 다 트리거: disk 중심으로 처리, scale 포함
 *
 * Note:
 *   memoryUsedPct는 NormalizedMetrics에서 사용 가능한 스토리지 압박의 간접 지표.
 *   MCP 어댑터 연동 시 diskUsedPct로 대체 가능.
 */
export class StorageBottleneckRule implements BottleneckRule {
  readonly id        = 'RULE_DISK_001'
  readonly type      = 'storage_bottleneck' as const
  readonly minPoints = 2

  evaluate(input: RuleInput): RuleResult | null {
    const avgQueueDepth = avg(input.points, 'diskQueueDepth')
    const avgMemoryPct  = avg(input.points, 'memoryUsedPct')

    const diskQueueTriggered = avgQueueDepth >= DISK_QUEUE_HIGH
    const memoryTriggered    = avgMemoryPct  >= MEMORY_HIGH_PCT

    if (!diskQueueTriggered && !memoryTriggered) return null

    const isCritical = avgQueueDepth >= DISK_QUEUE_CRITICAL

    const causes: string[] = []
    if (diskQueueTriggered) causes.push(`disk queue depth ${avgQueueDepth.toFixed(2)}`)
    if (memoryTriggered)    causes.push(`memory usage ${avgMemoryPct.toFixed(1)}%`)

    // 보수적 스케일 권고:
    //   - 디스크 큐가 트리거된 경우에만 scale 포함 (진짜 I/O 병목)
    //   - 메모리만 트리거된 경우 → 쿼리 개선 우선, scale 없음
    const recommendedActions = diskQueueTriggered
      ? ['check_disk_io', 'check_slow_queries', 'review_storage_tier', 'consider_scale_up']
      : ['check_slow_queries', 'optimize_aggregations', 'review_working_set_size']

    return {
      ruleId:   this.id,
      type:     this.type,
      severity: 'high',
      summary:  `${causes.join(', ')} exceeded threshold.` +
                (isCritical  ? ' Immediate storage review required.' : '') +
                (!diskQueueTriggered ? ' Inefficient queries may be causing memory pressure.' : ''),
      recommendedActions,
      signals: {
        avgDiskQueueDepth:  Math.round(avgQueueDepth * 100) / 100,
        avgMemoryUsedPct:   Math.round(avgMemoryPct * 10) / 10,
        diskQueueThreshold: DISK_QUEUE_HIGH,
        memoryThreshold:    MEMORY_HIGH_PCT,
        diskQueueTriggered: diskQueueTriggered ? 1 : 0,
        memoryTriggered:    memoryTriggered    ? 1 : 0,
      },
    }
  }
}

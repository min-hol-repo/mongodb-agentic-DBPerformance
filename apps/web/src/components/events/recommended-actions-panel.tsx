import { SeverityBadge } from '@/components/ui/severity-badge'
import { BOTTLENECK_LABELS } from '@/lib/api'
import type { BottleneckEvent } from '@/lib/api'
import { cn } from '@/lib/utils'

// ── 액션 우선순위 분류 ────────────────────────────────────────────
// query/index 검토 → 설정 최적화 → scale (마지막 수단)

const ACTION_PRIORITY: Record<string, number> = {
  // 인덱스/쿼리 개선 (최우선)
  review_indexes:             1,
  analyze_slow_queries:       2,
  run_explain_plan:           3,
  add_missing_indexes:        4,
  rewrite_inefficient_queries: 5,
  review_query_plans:         6,
  // 설정 최적화
  check_connection_pooling:   10,
  review_max_pool_size:       11,
  check_query_patterns:       12,
  check_indexes:              13,
  optimize_aggregations:      14,
  // I/O 검토
  check_disk_io:              20,
  check_slow_queries:         21,
  review_storage_tier:        22,
  review_working_set_size:    23,
  // scale (마지막 수단)
  review_query_efficiency_first: 40,
  consider_scale_up:          50,
}

const ACTION_LABELS: Record<string, string> = {
  review_indexes:               'Review Indexes',
  analyze_slow_queries:         'Analyze Slow Queries',
  run_explain_plan:             'Run Explain Plan',
  add_missing_indexes:          'Add Missing Indexes',
  rewrite_inefficient_queries:  'Rewrite Inefficient Queries',
  review_query_plans:           'Review Query Plans',
  check_connection_pooling:     'Check Connection Pool Settings',
  review_max_pool_size:         'Review Max Pool Size',
  check_query_patterns:         'Check Query Patterns',
  check_indexes:                'Check Index Health',
  optimize_aggregations:        'Optimize Aggregation Pipelines',
  check_disk_io:                'Check Disk I/O',
  check_slow_queries:           'Check Slow Queries',
  review_storage_tier:          'Review Storage Tier',
  review_working_set_size:      'Review Working Set Size',
  review_query_efficiency_first: 'Improve Query Efficiency First',
  consider_scale_up:            'Consider Cluster Scale-Up',
}

const ACTION_CATEGORY: Record<string, 'query' | 'config' | 'storage' | 'scale'> = {
  review_indexes: 'query', analyze_slow_queries: 'query', run_explain_plan: 'query',
  add_missing_indexes: 'query', rewrite_inefficient_queries: 'query', review_query_plans: 'query',
  check_connection_pooling: 'config', review_max_pool_size: 'config',
  check_query_patterns: 'config', check_indexes: 'config', optimize_aggregations: 'config',
  check_disk_io: 'storage', check_slow_queries: 'storage', review_storage_tier: 'storage',
  review_working_set_size: 'storage',
  review_query_efficiency_first: 'scale', consider_scale_up: 'scale',
}

const CATEGORY_STYLES: Record<string, { bg: string; text: string; label: string }> = {
  query:   { bg: 'bg-blue-100',   text: 'text-blue-700',   label: 'Query / Index' },
  config:  { bg: 'bg-slate-100',  text: 'text-slate-700',  label: 'Configuration' },
  storage: { bg: 'bg-purple-100', text: 'text-purple-700', label: 'Storage' },
  scale:   { bg: 'bg-amber-100',  text: 'text-amber-700',  label: 'Scale' },
}

interface ActionItem {
  action:      string
  priority:    number
  sourceEvents: BottleneckEvent[]
}

interface RecommendedActionsPanelProps {
  openEvents: BottleneckEvent[]
}

export function RecommendedActionsPanel({ openEvents }: RecommendedActionsPanelProps) {
  if (openEvents.length === 0) {
    return (
      <div className="rounded-lg border border-dashed bg-white py-8 text-center">
        <p className="text-sm text-muted-foreground">No recommended actions.</p>
        <p className="mt-0.5 text-xs text-muted-foreground">All metrics are within normal range.</p>
      </div>
    )
  }

  // 전체 액션 집계 + 중복 제거 + 우선순위 정렬
  const actionMap = new Map<string, BottleneckEvent[]>()
  for (const event of openEvents) {
    for (const action of event.recommendedActions) {
      const existing = actionMap.get(action) ?? []
      actionMap.set(action, [...existing, event])
    }
  }

  const sorted: ActionItem[] = [...actionMap.entries()]
    .map(([action, sourceEvents]) => ({
      action,
      priority:    ACTION_PRIORITY[action] ?? 99,
      sourceEvents,
    }))
    .sort((a, b) => a.priority - b.priority)

  // scale 액션 여부
  const hasScaleAction = sorted.some(a =>
    a.action === 'consider_scale_up' || a.action === 'review_query_efficiency_first',
  )

  return (
    <div className="rounded-lg border bg-white">
      {hasScaleAction && (
        <div className="rounded-t-lg border-b bg-amber-50 px-4 py-2.5">
          <p className="text-xs text-amber-700">
            ⚠ Scale-up appears in the list — resolve query/index issues first. Scale is a last resort.
          </p>
        </div>
      )}

      <div className="divide-y">
        {sorted.map(({ action, priority, sourceEvents }, idx) => {
          const category    = ACTION_CATEGORY[action] ?? 'config'
          const catStyle    = CATEGORY_STYLES[category]
          const isScale     = category === 'scale'

          return (
            <div
              key={action}
              className={cn(
                'flex items-start gap-4 px-4 py-3',
                isScale && 'opacity-60',
              )}
            >
              {/* 순서 번호 */}
              <span
                className={cn(
                  'mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-bold',
                  isScale ? 'bg-amber-100 text-amber-700' : 'bg-slate-100 text-slate-600',
                )}
              >
                {idx + 1}
              </span>

              {/* 내용 */}
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium text-foreground">
                    {ACTION_LABELS[action] ?? action.replace(/_/g, ' ')}
                  </span>
                  <span
                    className={cn(
                      'rounded px-1.5 py-0.5 text-xs font-medium',
                      catStyle.bg, catStyle.text,
                    )}
                  >
                    {catStyle.label}
                  </span>
                  {isScale && (
                    <span className="text-xs text-amber-600">(last resort)</span>
                  )}
                </div>

                {/* 출처 이벤트 */}
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {sourceEvents.map(e => (
                    <span key={e._id} className="flex items-center gap-1">
                      <SeverityBadge severity={e.severity} className="scale-90" />
                      <span className="text-xs text-muted-foreground">
                        {BOTTLENECK_LABELS[e.type]}
                      </span>
                    </span>
                  ))}
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

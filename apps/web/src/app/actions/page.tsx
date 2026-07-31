import { Clock, CheckCircle, History } from 'lucide-react'
import { EmptyState } from '@/components/ui/empty-state'
import { StatusBadge } from '@/components/ui/status-badge'
import { ApprovalCard } from '@/components/actions/approval-card'
import {
  ACTION_LABELS, MODE_LABELS, relativeTime,
  DEFAULT_CLUSTER, fetchActions,
  type ActuatorAction,
} from '@/lib/api'

export const dynamic = 'force-dynamic'

export default async function ActionsPage() {
  const clusterName = DEFAULT_CLUSTER

  const actionsRes = await fetchActions(clusterName, 30).catch(() => ({ actions: [] }))
  const allActions = actionsRes.actions

  const pending  = allActions.filter(a => a.result === 'pending')
  const history  = allActions.filter(a => a.result !== 'pending')

  const cooldownActions = allActions.filter(a =>
    a.cooldownUntil && new Date(a.cooldownUntil) > new Date(),
  )

  return (
    <div className="space-y-8">
      {/* ── 헤더 ── */}
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Actions</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Actuator recommendations for <strong>{clusterName}</strong>
          {pending.length > 0 && (
            <span className="ml-2 inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-700">
              {pending.length} pending approval{pending.length > 1 ? 's' : ''}
            </span>
          )}
        </p>
      </div>

      {/* ── Pending Approvals ── */}
      <section>
        <h2 className="mb-3 flex items-center gap-2 text-base font-semibold">
          <Clock className="h-4 w-4 text-amber-500" />
          Pending Approvals
          {pending.length > 0 && (
            <span className="rounded-full bg-amber-500 px-1.5 py-0.5 text-xs text-white">
              {pending.length}
            </span>
          )}
        </h2>

        {pending.length > 0 ? (
          <div className="space-y-3">
            {pending.map(action => (
              <ApprovalCard key={action._id} action={action} />
            ))}
          </div>
        ) : (
          <EmptyState
            title="No pending approvals"
            description="All actuator recommendations have been processed."
            icon={<CheckCircle className="h-8 w-8" />}
          />
        )}
      </section>

      {/* ── Cooldown Status ── */}
      {cooldownActions.length > 0 && (
        <section>
          <h2 className="mb-3 flex items-center gap-2 text-base font-semibold">
            <Clock className="h-4 w-4 text-muted-foreground" />
            Active Cooldowns
          </h2>
          <div className="divide-y rounded-lg border bg-white">
            {cooldownActions.map(a => (
              <div key={a._id} className="flex items-center justify-between px-4 py-3">
                <div>
                  <p className="text-sm font-medium">{ACTION_LABELS[a.actionType]}</p>
                  <p className="font-mono text-xs text-muted-foreground">{a.ruleId}</p>
                </div>
                <div className="text-right">
                  <p className="text-xs font-medium text-amber-600">
                    Until {new Date(a.cooldownUntil!).toLocaleTimeString('ko-KR')}
                  </p>
                  <StatusBadge status={a.result} className="mt-0.5" />
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* ── Action History ── */}
      <section>
        <h2 className="mb-3 flex items-center gap-2 text-base font-semibold">
          <History className="h-4 w-4 text-muted-foreground" />
          Action History
          <span className="text-sm font-normal text-muted-foreground">({history.length})</span>
        </h2>
        <div className="rounded-lg border bg-white px-4">
          {history.length > 0 ? (
            history.map(action => (
              <HistoryRow key={action._id} action={action} />
            ))
          ) : (
            <EmptyState
              title="No action history"
              description="Actions will appear here once the actuator generates recommendations."
              className="border-0 py-10"
            />
          )}
        </div>
      </section>
    </div>
  )
}

// ── 이력 행 컴포넌트 ─────────────────────────────────────────────

function HistoryRow({ action }: { action: ActuatorAction }) {
  return (
    <div className="flex items-start gap-3 border-b py-3 last:border-0">
      <StatusBadge status={action.result} className="mt-0.5 shrink-0" />
      <div className="min-w-0 flex-1">
        {/* 첫 번째 행 */}
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm font-medium">
            {ACTION_LABELS[action.actionType] ?? action.actionType}
          </p>
          <span className="shrink-0 text-xs text-muted-foreground">
            {relativeTime(action.timestamp)}
          </span>
        </div>

        {/* 두 번째 행 */}
        <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span className="rounded bg-slate-100 px-1.5 py-0.5 text-slate-600">
            {MODE_LABELS[action.mode] ?? action.mode}
          </span>
          {action.ruleId && (
            <span className="font-mono">{action.ruleId}</span>
          )}
          {action.result === 'approved' && action.approvedAt && (
            <span className="text-green-700 font-medium">
              ✓ Approved {relativeTime(action.approvedAt)}
            </span>
          )}
          {action.result === 'rejected' && action.rejectedAt && (
            <span className="text-red-600 font-medium">
              ✗ Rejected {relativeTime(action.rejectedAt)}
              {action.auditLog?.at(-1)?.note && (
                <span className="ml-1 font-normal italic text-muted-foreground">
                  — &quot;{action.auditLog.at(-1)!.note}&quot;
                </span>
              )}
            </span>
          )}
        </div>

        {/* 상태 전이 */}
        {action.beforeState?.tier && action.proposedState?.tier && (
          <p className="mt-0.5 text-xs text-muted-foreground">
            {String(action.beforeState.tier)} → {String(action.proposedState.tier)}
          </p>
        )}
      </div>
    </div>
  )
}

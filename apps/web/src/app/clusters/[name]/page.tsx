import Link from 'next/link'
import { AlertCircle, Activity, Lightbulb, History, Shield } from 'lucide-react'
import { EmptyState } from '@/components/ui/empty-state'
import { ActionRow } from '@/components/actions/action-row'
import { HealthSummary } from '@/components/metrics/health-summary'
import { MetricsGrid } from '@/components/metrics/metric-chart'
import { RuleHitTimeline } from '@/components/events/rule-hit-timeline'
import { RecommendedActionsPanel } from '@/components/events/recommended-actions-panel'
import {
  fetchMetrics,
  fetchOpenEvents,
  fetchEvents,
  fetchActions,
  fetchPolicy,
  MODE_LABELS,
} from '@/lib/api'

export const dynamic = 'force-dynamic'

type Props = { params: { name: string } }

export default async function ClusterDetailPage({ params }: Props) {
  const { name } = params

  // ── 병렬 데이터 패칭 ─────────────────────────────────────────
  const [metricsRes, openEventsRes, allEventsRes, actionsRes, policyRes] =
    await Promise.allSettled([
      fetchMetrics(name, 60),
      fetchOpenEvents(name),
      fetchEvents(name, { limit: 20 }),
      fetchActions(name, 10),
      fetchPolicy(name),
    ])

  const metrics    = metricsRes.status    === 'fulfilled' ? metricsRes.value.metrics           : []
  const openEvents = openEventsRes.status === 'fulfilled' ? openEventsRes.value.events          : []
  const allEvents  = allEventsRes.status  === 'fulfilled' ? allEventsRes.value.events           : []
  const actions    = actionsRes.status    === 'fulfilled' ? actionsRes.value.actions            : []
  const policy     = policyRes.status     === 'fulfilled' ? policyRes.value                      : null

  const latestMetric    = metrics.at(-1)
  const highSeverity    = openEvents.filter(e => e.severity === 'high').length
  const pendingActions  = actions.filter(a => a.result === 'pending').length

  // 전체 상태 신호
  const overallStatus =
    highSeverity > 0
      ? 'critical'
      : openEvents.length > 0
        ? 'warning'
        : 'ok'

  const STATUS_CONFIG = {
    ok:       { text: '✓ Healthy',        color: 'text-green-600' },
    warning:  { text: '⚠ Issues Detected', color: 'text-amber-600' },
    critical: { text: '✗ Critical Issues', color: 'text-red-600' },
  }

  return (
    <div className="space-y-8">

      {/* ── 1. 페이지 헤더 ──────────────────────────────────────── */}
      <div className="flex items-start justify-between gap-4">
        <div>
          {/* 브레드크럼 */}
          <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
            <Link href="/" className="hover:text-foreground">Overview</Link>
            <span>/</span>
            <span className="text-foreground font-medium">{name}</span>
          </div>

          {/* 클러스터명 + 상태 */}
          <div className="mt-1 flex items-center gap-3 flex-wrap">
            <h1 className="text-2xl font-bold tracking-tight">{name}</h1>
            <span className={`text-sm font-semibold ${STATUS_CONFIG[overallStatus].color}`}>
              {STATUS_CONFIG[overallStatus].text}
            </span>
          </div>

          {/* 서브 정보 */}
          <div className="mt-1 flex items-center gap-4 text-xs text-muted-foreground flex-wrap">
            {openEvents.length > 0 && (
              <span className="flex items-center gap-1 text-red-600 font-medium">
                <AlertCircle className="h-3.5 w-3.5" />
                {openEvents.length} open event{openEvents.length > 1 ? 's' : ''}
                {highSeverity > 0 && ` (${highSeverity} high)`}
              </span>
            )}
            {pendingActions > 0 && (
              <span className="text-amber-600 font-medium">
                {pendingActions} pending action{pendingActions > 1 ? 's' : ''}
              </span>
            )}
            {policy && (
              <span>
                Mode: <span className="font-medium text-foreground">{MODE_LABELS[policy.mode]}</span>
              </span>
            )}
            {latestMetric && (
              <span>
                Last updated: {new Date(latestMetric.timestamp).toLocaleTimeString('ko-KR')}
              </span>
            )}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {pendingActions > 0 && (
            <Link
              href="/actions"
              className="rounded-md bg-amber-500 px-3 py-1.5 text-xs font-semibold text-white hover:bg-amber-600 transition-colors"
            >
              {pendingActions} Pending →
            </Link>
          )}
          <Link
            href="/policies"
            className="rounded-md border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-muted-foreground hover:border-slate-300 hover:text-foreground transition-colors"
          >
            Edit Policy
          </Link>
        </div>
      </div>

      {/* ── 2. Health Summary ───────────────────────────────────── */}
      <section>
        <SectionHeader icon={<Activity className="h-4 w-4" />} title="Current Health">
          {latestMetric ? (
            <span className="text-xs text-muted-foreground">
              Based on latest metrics · {new Date(latestMetric.timestamp).toLocaleTimeString('ko-KR')}
            </span>
          ) : null}
        </SectionHeader>
        <HealthSummary latest={latestMetric} openEvents={openEvents} />
      </section>

      {/* ── 3. Metric Charts ────────────────────────────────────── */}
      <section>
        <SectionHeader icon={<Activity className="h-4 w-4" />} title="Metrics — Last 30 min">
          <span className="text-xs text-muted-foreground">
            {metrics.length} data points · dashed line = threshold
          </span>
        </SectionHeader>
        <MetricsGrid data={metrics} />
      </section>

      {/* ── 4. Recommended Actions ──────────────────────────────── */}
      {openEvents.length > 0 && (
        <section>
          <SectionHeader
            icon={<Lightbulb className="h-4 w-4 text-amber-500" />}
            title="Recommended Actions"
          >
            <span className="text-xs text-muted-foreground">
              Aggregated from {openEvents.length} active event{openEvents.length > 1 ? 's' : ''} · sorted by priority
            </span>
          </SectionHeader>
          <RecommendedActionsPanel openEvents={openEvents} />
        </section>
      )}

      {/* ── 5. Rule Hit Timeline ────────────────────────────────── */}
      <section>
        <SectionHeader
          icon={<AlertCircle className="h-4 w-4" />}
          title="Rule Hit History"
          badge={openEvents.length > 0 ? (
            <span className="rounded-full bg-red-500 px-1.5 py-0.5 text-xs text-white">
              {openEvents.length} open
            </span>
          ) : undefined}
        >
          <span className="text-xs text-muted-foreground">
            {allEvents.length} event{allEvents.length !== 1 ? 's' : ''} recorded
          </span>
        </SectionHeader>
        <RuleHitTimeline events={allEvents} />
      </section>

      {/* ── 6. Actuator Action History ──────────────────────────── */}
      <section>
        <SectionHeader
          icon={<History className="h-4 w-4" />}
          title="Actuator Actions"
        >
          <Link href="/actions" className="text-xs text-blue-600 hover:underline">
            View all →
          </Link>
        </SectionHeader>
        <div className="rounded-lg border bg-white px-4">
          {actions.length > 0 ? (
            actions.map(action => (
              <ActionRow key={action._id} action={action} compact />
            ))
          ) : (
            <EmptyState
              title="No actuator actions yet"
              description="Actions appear once the actuator worker generates recommendations."
              className="border-0 py-8"
            />
          )}
        </div>
      </section>

      {/* ── 7. Active Policy ────────────────────────────────────── */}
      {policy && (
        <section>
          <SectionHeader icon={<Shield className="h-4 w-4" />} title="Active Policy">
            <Link href="/policies" className="text-xs text-blue-600 hover:underline">
              Edit →
            </Link>
          </SectionHeader>
          <div className="rounded-lg border bg-white p-4">
            <div className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
              <PolicyItem label="Mode"      value={MODE_LABELS[policy.mode]} />
              <PolicyItem label="Max Tier"  value={policy.maxTier} />
              <PolicyItem label="Cooldown"  value={`${policy.cooldownMinutes} min`} />
              <PolicyItem
                label="Blocked"
                value={policy.blockedActions.length > 0 ? policy.blockedActions.join(', ') : 'None'}
              />
            </div>
          </div>
        </section>
      )}

    </div>
  )
}

// ── 공통 섹션 헤더 컴포넌트 ──────────────────────────────────────

function SectionHeader({
  icon, title, badge, children,
}: {
  icon:      React.ReactNode
  title:     string
  badge?:    React.ReactNode
  children?: React.ReactNode
}) {
  return (
    <div className="mb-3 flex items-center justify-between gap-2">
      <h2 className="flex items-center gap-2 text-base font-semibold text-foreground">
        <span className="text-muted-foreground">{icon}</span>
        {title}
        {badge}
      </h2>
      <div>{children}</div>
    </div>
  )
}

function PolicyItem({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-0.5 text-sm font-medium text-foreground">{value}</p>
    </div>
  )
}

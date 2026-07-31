import Link from 'next/link'
import { AlertCircle, Activity, Zap, Server } from 'lucide-react'
import { StatCard } from '@/components/ui/stat-card'
import { EmptyState } from '@/components/ui/empty-state'
import { EventRow } from '@/components/events/event-row'
import {
  DEFAULT_CLUSTER,
  fetchEvents,
  fetchOpenEvents,
  fetchActions,
} from '@/lib/api'

export const dynamic = 'force-dynamic'

export default async function OverviewPage() {
  const clusterName = DEFAULT_CLUSTER

  // ── 데이터 병렬 패칭 ─────────────────────────────────────────
  const [eventsRes, openEventsRes, actionsRes] = await Promise.allSettled([
    fetchEvents(clusterName, { limit: 6 }),
    fetchOpenEvents(clusterName),
    fetchActions(clusterName, 5),
  ])

  const recentEvents  = eventsRes.status === 'fulfilled'      ? eventsRes.value.events      : []
  const openEvents    = openEventsRes.status === 'fulfilled'   ? openEventsRes.value.events   : []
  const recentActions = actionsRes.status === 'fulfilled'      ? actionsRes.value.actions      : []

  const pendingActions = recentActions.filter(a => a.result === 'pending')

  const highEvents   = openEvents.filter(e => e.severity === 'high').length
  const mediumEvents = openEvents.filter(e => e.severity === 'medium').length

  // severity accent 결정
  const eventAccent = highEvents > 0 ? 'red' : mediumEvents > 0 ? 'amber' : 'green'
  const actionAccent = pendingActions.length > 0 ? 'amber' : 'gray'

  return (
    <div className="space-y-8">
      {/* ── 페이지 헤더 ── */}
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-foreground">Overview</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Cluster: <Link href={`/clusters/${clusterName}`} className="text-blue-600 hover:underline font-medium">{clusterName}</Link>
        </p>
      </div>

      {/* ── Stat Cards ── */}
      <section>
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <StatCard
            label="Open Events"
            value={openEvents.length}
            sub={highEvents > 0 ? `${highEvents} high severity` : 'No high severity'}
            accent={eventAccent}
          />
          <StatCard
            label="Pending Actions"
            value={pendingActions.length}
            sub={pendingActions.length > 0 ? 'Awaiting approval' : 'Nothing pending'}
            accent={actionAccent}
          />
          <StatCard
            label="Cluster"
            value="1"
            sub={clusterName}
            accent="blue"
          />
          <StatCard
            label="Collector"
            value={recentEvents.length > 0 ? 'Active' : '—'}
            sub={recentEvents.length > 0 ? 'Metrics being collected' : 'No data yet'}
            accent={recentEvents.length > 0 ? 'green' : 'gray'}
          />
        </div>
      </section>

      {/* ── Recent Bottleneck Events ── */}
      <section>
        <div className="flex items-center justify-between mb-3">
          <h2 className="flex items-center gap-2 text-base font-semibold text-foreground">
            <AlertCircle className="h-4 w-4 text-muted-foreground" />
            Recent Bottleneck Events
          </h2>
          <Link
            href={`/clusters/${clusterName}`}
            className="text-sm text-blue-600 hover:underline"
          >
            View cluster →
          </Link>
        </div>

        <div className="rounded-lg border bg-white px-4">
          {recentEvents.length > 0 ? (
            recentEvents.map(event => (
              <EventRow key={event._id} event={event} />
            ))
          ) : (
            <EmptyState
              title="No bottleneck events"
              description="The detector has not found any issues yet."
              icon={<Activity className="h-8 w-8" />}
              className="border-0 py-10"
            />
          )}
        </div>
      </section>

      {/* ── Quick Links ── */}
      <section>
        <h2 className="flex items-center gap-2 text-base font-semibold text-foreground mb-3">
          <Server className="h-4 w-4 text-muted-foreground" />
          Quick Navigation
        </h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Link
            href={`/clusters/${clusterName}`}
            className="rounded-lg border bg-white p-4 hover:border-blue-300 hover:bg-blue-50 transition-colors"
          >
            <p className="text-sm font-medium text-foreground">Cluster Detail</p>
            <p className="mt-0.5 text-xs text-muted-foreground">Metrics charts &amp; events</p>
          </Link>
          <Link
            href="/actions"
            className={`rounded-lg border bg-white p-4 hover:border-amber-300 hover:bg-amber-50 transition-colors ${
              pendingActions.length > 0 ? 'border-amber-300 bg-amber-50' : ''
            }`}
          >
            <p className="text-sm font-medium text-foreground flex items-center gap-2">
              Actions
              {pendingActions.length > 0 && (
                <span className="rounded-full bg-amber-500 px-1.5 py-0.5 text-xs text-white">
                  {pendingActions.length}
                </span>
              )}
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">Approvals &amp; history</p>
          </Link>
          <Link
            href="/policies"
            className="rounded-lg border bg-white p-4 hover:border-slate-300 hover:bg-slate-50 transition-colors"
          >
            <p className="text-sm font-medium text-foreground flex items-center gap-1.5">
              <Zap className="h-3.5 w-3.5" />
              Policies
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">Actuator configuration</p>
          </Link>
        </div>
      </section>
    </div>
  )
}

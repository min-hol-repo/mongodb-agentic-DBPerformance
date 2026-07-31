import { Shield, AlertTriangle } from 'lucide-react'
import { DEFAULT_CLUSTER, fetchPolicy, MODE_LABELS } from '@/lib/api'

export const dynamic = 'force-dynamic'

export default async function PoliciesPage() {
  const clusterName = DEFAULT_CLUSTER
  const policy = await fetchPolicy(clusterName).catch(() => null)

  return (
    <div className="space-y-8">
      {/* ── 헤더 ── */}
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Policies</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Actuator configuration for <strong>{clusterName}</strong>
        </p>
      </div>

      {policy ? (
        <>
          {/* ── 현재 정책 카드 ── */}
          <section>
            <h2 className="mb-3 flex items-center gap-2 text-base font-semibold">
              <Shield className="h-4 w-4 text-muted-foreground" />
              Current Policy
            </h2>
            <div className="rounded-lg border bg-white p-6 space-y-5">

              {/* Mode */}
              <div>
                <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground mb-2">
                  Actuator Mode
                </p>
                <div className="flex gap-3 flex-wrap">
                  {(['dry_run', 'approval_required', 'auto_execute'] as const).map(mode => (
                    <div
                      key={mode}
                      className={`rounded-lg border px-4 py-2.5 text-sm font-medium transition-colors ${
                        policy.mode === mode
                          ? mode === 'auto_execute'
                            ? 'border-red-300 bg-red-50 text-red-700'
                            : 'border-blue-300 bg-blue-50 text-blue-700'
                          : 'border-gray-200 bg-white text-muted-foreground'
                      }`}
                    >
                      {MODE_LABELS[mode]}
                      {policy.mode === mode && (
                        <span className="ml-2 text-xs">(active)</span>
                      )}
                      {mode === 'auto_execute' && (
                        <span className="ml-1 text-xs text-red-500">⚠ MVP disabled</span>
                      )}
                    </div>
                  ))}
                </div>
              </div>

              {/* Grid: MaxTier + Cooldown */}
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-4 border-t pt-4">
                <div>
                  <p className="text-xs text-muted-foreground">Max Tier</p>
                  <p className="mt-1 text-2xl font-bold text-foreground">{policy.maxTier}</p>
                  <p className="text-xs text-muted-foreground">Scale ceiling</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Cooldown</p>
                  <p className="mt-1 text-2xl font-bold text-foreground">{policy.cooldownMinutes}</p>
                  <p className="text-xs text-muted-foreground">minutes</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Allowed Actions</p>
                  <ul className="mt-1 space-y-0.5">
                    {policy.allowActions.map(a => (
                      <li key={a} className="flex items-center gap-1 text-xs text-green-700">
                        <span className="text-green-500">✓</span>
                        {a.replace(/_/g, ' ')}
                      </li>
                    ))}
                  </ul>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Blocked Actions</p>
                  {policy.blockedActions.length > 0 ? (
                    <ul className="mt-1 space-y-0.5">
                      {policy.blockedActions.map(a => (
                        <li key={a} className="flex items-center gap-1 text-xs text-red-600">
                          <span>✗</span>
                          {a.replace(/_/g, ' ')}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="mt-1 text-xs text-muted-foreground">None explicitly blocked</p>
                  )}
                </div>
              </div>

              {/* Last updated */}
              <p className="text-xs text-muted-foreground border-t pt-3">
                Last updated: {new Date(policy.updatedAt).toLocaleString('ko-KR')}
              </p>
            </div>
          </section>

          {/* ── Safety Notice ── */}
          <section className="rounded-lg border border-amber-200 bg-amber-50 p-4">
            <div className="flex items-start gap-3">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
              <div className="space-y-1">
                <p className="text-sm font-medium text-amber-800">Safety Guardrails (MVP)</p>
                <ul className="space-y-0.5 text-xs text-amber-700 list-disc list-inside">
                  <li><strong>auto_execute</strong> mode is disabled in this MVP</li>
                  <li><strong>scale_down</strong> is always blocked regardless of policy</li>
                  <li>All scale actions require explicit approval in <strong>approval_required</strong> mode</li>
                  <li>Cooldown prevents repeated actions within {policy.cooldownMinutes} minutes</li>
                </ul>
              </div>
            </div>
          </section>

          <p className="text-xs text-muted-foreground text-center">
            Policy editing will be available in Phase 8. Use <code className="font-mono">PATCH /api/policies/{clusterName}</code> directly for now.
          </p>
        </>
      ) : (
        <div className="rounded-lg border border-dashed bg-white p-12 text-center">
          <Shield className="mx-auto h-10 w-10 text-muted-foreground mb-3" />
          <p className="text-sm font-medium text-foreground">No policy configured</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Policy will be auto-created when the actuator worker starts.
          </p>
        </div>
      )}
    </div>
  )
}

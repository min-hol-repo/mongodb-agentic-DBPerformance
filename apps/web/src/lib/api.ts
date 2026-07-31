const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000'

// ── 공통 fetch 유틸 ───────────────────────────────────────────────

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    next: { revalidate: 0 },   // SSR에서 항상 최신 데이터
    ...init,
  })
  if (!res.ok) {
    throw new Error(`API error: ${res.status} ${res.statusText}`)
  }
  return res.json() as Promise<T>
}

// ── 타입 정의 ─────────────────────────────────────────────────────

export type Severity    = 'low' | 'medium' | 'high'
export type EventStatus = 'open' | 'resolved' | 'suppressed'
export type BottleneckType =
  | 'connection_pressure'
  | 'cpu_saturation'
  | 'storage_bottleneck'
  | 'query_inefficiency'

export type ActuatorMode   = 'dry_run' | 'approval_required' | 'auto_execute'
export type ActionType     = 'scale_recommendation' | 'scale_up_request' | 'notify_only'
export type ActionStatus   = 'pending' | 'approved' | 'rejected' | 'executed' | 'not_executed'

export interface BottleneckEvent {
  _id:               string
  timestamp:         string
  clusterName:       string
  projectId:         string
  severity:          Severity
  type:              BottleneckType
  ruleId:            string
  summary:           string
  recommendedActions: string[]
  status:            EventStatus
  signals?:          Record<string, number>
}

export interface MetricsPoint {
  timestamp: string
  metrics: {
    connections:      number
    cpuNormalizedPct: number
    memoryUsedPct:    number
    diskUsedGb:       number
    diskQueueDepth:   number
    readLatencyMs:    number
    writeLatencyMs:   number
    queryTargeting:   number
  }
}

export interface AuditEntry {
  at:    string
  from:  ActionStatus
  to:    ActionStatus
  actor: 'operator' | 'system'
  note?: string
}

export interface ActuatorAction {
  _id:           string
  timestamp:     string
  clusterName:   string
  actionType:    ActionType
  mode:          ActuatorMode
  reason:        string
  ruleId?:       string
  beforeState?:  Record<string, unknown>
  proposedState?: Record<string, unknown>
  result:        ActionStatus
  cooldownUntil?: string
  approvedAt?:   string
  rejectedAt?:   string
  auditLog?:     AuditEntry[]
}

export interface ActuatorPolicy {
  clusterName:    string
  mode:           ActuatorMode
  maxTier:        string
  cooldownMinutes: number
  allowActions:   ActionType[]
  blockedActions: ActionType[]
  updatedAt:      string
}

export interface HealthResponse {
  status:    string
  db:        'connected' | 'disconnected'
  uptime:    number
  service:   string
}

// ── API 함수 ──────────────────────────────────────────────────────

const CLUSTER = process.env.NEXT_PUBLIC_CLUSTER_NAME
  ?? process.env.ATLAS_CLUSTER_NAME
  ?? 'perf-demo'

export const DEFAULT_CLUSTER = CLUSTER

export async function fetchHealth(): Promise<HealthResponse> {
  return apiFetch<HealthResponse>('/api/health')
}

export async function fetchEvents(
  clusterName: string,
  opts: { status?: EventStatus; limit?: number; since?: string } = {},
): Promise<{ events: BottleneckEvent[]; total: number }> {
  const params = new URLSearchParams()
  if (opts.status) params.set('status', opts.status)
  if (opts.limit)  params.set('limit', String(opts.limit))
  if (opts.since)  params.set('since', opts.since)
  const qs = params.toString()
  return apiFetch<{ events: BottleneckEvent[]; total: number }>(
    `/api/clusters/${clusterName}/events${qs ? `?${qs}` : ''}`,
  )
}

export async function fetchOpenEvents(
  clusterName: string,
): Promise<{ events: BottleneckEvent[]; total: number }> {
  return apiFetch<{ events: BottleneckEvent[]; total: number }>(
    `/api/clusters/${clusterName}/events/open`,
  )
}

export async function fetchMetrics(
  clusterName: string,
  limit = 60,
): Promise<{ metrics: MetricsPoint[] }> {
  return apiFetch<{ metrics: MetricsPoint[] }>(
    `/api/clusters/${clusterName}/metrics?limit=${limit}`,
  )
}

export async function fetchActions(
  clusterName: string,
  limit = 20,
): Promise<{ actions: ActuatorAction[] }> {
  return apiFetch<{ actions: ActuatorAction[] }>(
    `/api/clusters/${clusterName}/actions?limit=${limit}`,
  )
}

export async function fetchPolicy(
  clusterName: string,
): Promise<ActuatorPolicy> {
  return apiFetch<ActuatorPolicy>(`/api/policies/${clusterName}`)
}

export async function approveAction(actionId: string): Promise<ActuatorAction> {
  return apiFetch<ActuatorAction>(`/api/actions/${actionId}/approve`, {
    method: 'POST',
  })
}

export async function rejectAction(actionId: string, reason?: string): Promise<ActuatorAction> {
  return apiFetch<ActuatorAction>(`/api/actions/${actionId}/reject`, {
    method: 'POST',
    body:   JSON.stringify({ reason }),
  })
}

// ── 표시용 헬퍼 ──────────────────────────────────────────────────

export const BOTTLENECK_LABELS: Record<BottleneckType, string> = {
  connection_pressure:  'Connection Pressure',
  cpu_saturation:       'CPU Saturation',
  storage_bottleneck:   'Storage Bottleneck',
  query_inefficiency:   'Query Inefficiency',
}

export const ACTION_LABELS: Record<ActionType, string> = {
  scale_recommendation: 'Scale Recommendation',
  scale_up_request:     'Scale Up Request',
  notify_only:          'Notify Only',
}

export const MODE_LABELS: Record<ActuatorMode, string> = {
  dry_run:           'Dry Run',
  approval_required: 'Approval Required',
  auto_execute:      'Auto Execute',
}

export function relativeTime(isoString: string): string {
  const diff = Date.now() - new Date(isoString).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1)  return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24)  return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

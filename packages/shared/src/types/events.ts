export type Severity = 'low' | 'medium' | 'high'
export type EventStatus = 'open' | 'resolved' | 'suppressed'
export type BottleneckType =
  | 'connection_pressure'
  | 'cpu_saturation'
  | 'storage_bottleneck'
  | 'query_inefficiency'

export interface BottleneckEvent {
  timestamp: Date
  projectId: string
  clusterName: string
  severity: Severity
  type: BottleneckType
  ruleId: string
  summary: string
  recommendedActions: string[]
  status: EventStatus
  signals?: Record<string, number>
}

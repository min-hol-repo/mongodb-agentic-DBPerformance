import type { NormalizedMetrics } from '@demo/shared'

export interface MetricsAdapterResult {
  clusterName: string
  projectId: string
  /** 어댑터 식별자 + 시나리오 (예: 'mock:normal', 'atlas-mcp') */
  source: string
  timestamp: Date
  metrics: NormalizedMetrics
}

export interface MetricsAdapter {
  /** 어댑터 식별자 */
  readonly name: string

  /**
   * 어댑터가 현재 사용 가능한 상태인지 확인한다.
   * 연결 오류가 발생해도 예외를 던지지 않고 false를 반환한다.
   */
  isAvailable(): Promise<boolean>

  /**
   * 주어진 클러스터의 최신 메트릭을 수집하고 정규화된 결과를 반환한다.
   */
  collect(clusterName: string): Promise<MetricsAdapterResult>
}

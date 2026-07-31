/**
 * 어댑터가 현재 사용 불가 상태일 때 던진다.
 * (MCP 연결 실패, Atlas API 인증 오류 등)
 */
export class AdapterUnavailableError extends Error {
  constructor(adapterName: string, reason?: string) {
    super(
      `Adapter '${adapterName}' is unavailable` +
      (reason ? `: ${reason}` : ''),
    )
    this.name = 'AdapterUnavailableError'
  }
}

/**
 * 메트릭 수집 중 오류가 발생했을 때 던진다.
 * 원인 오류를 `cause` 속성으로 보존한다.
 */
export class MetricsCollectionError extends Error {
  readonly clusterName: string

  constructor(clusterName: string, cause: unknown) {
    const msg = cause instanceof Error ? cause.message : String(cause)
    super(`Failed to collect metrics for '${clusterName}': ${msg}`)
    this.name = 'MetricsCollectionError'
    this.clusterName = clusterName
    if (cause instanceof Error) this.cause = cause
  }
}

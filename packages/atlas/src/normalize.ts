import type { NormalizedMetrics } from '@demo/shared'

// ── Atlas Metrics API 측정값 이름 상수 ───────────────────────────
// 실제 Atlas Admin API v2 에서 검증된 메트릭 이름만 사용한다.

/** 프로세스 레벨 API에서 수집하는 메트릭 이름 목록 */
export const PROCESS_METRIC_NAMES = [
  'CONNECTIONS',
  'SYSTEM_NORMALIZED_CPU_USER',
  'SYSTEM_NORMALIZED_CPU_KERNEL',
  'SYSTEM_MEMORY_USED',
  'SYSTEM_MEMORY_AVAILABLE',
  'OP_EXECUTION_TIME_READS',
  'OP_EXECUTION_TIME_WRITES',
  'QUERY_TARGETING_SCANNED_OBJECTS_PER_RETURNED',
] as const

/** 디스크 파티션 레벨 API에서 수집하는 메트릭 이름 목록 */
export const DISK_METRIC_NAMES = [
  'DISK_QUEUE_DEPTH',
  'DISK_PARTITION_SPACE_USED',
] as const

/** Atlas Metrics API 원시 데이터포인트 */
export interface AtlasDataPoint {
  timestamp: string
  value: number | null
}

/** Atlas Metrics API 원시 측정값 */
export interface AtlasRawMeasurement {
  name: string
  units: string
  dataPoints: AtlasDataPoint[]
}

/** 모든 필드가 0인 빈 메트릭 (Atlas 응답에 값이 없을 때 사용) */
export const EMPTY_METRICS: NormalizedMetrics = {
  connections:      0,
  cpuNormalizedPct: 0,
  memoryUsedPct:    0,
  diskUsedGb:       0,
  diskQueueDepth:   0,
  readLatencyMs:    0,
  writeLatencyMs:   0,
  queryTargeting:   0,
}

/**
 * 측정값 배열에서 특정 이름의 가장 최신 non-null 값을 반환한다.
 * 값이 없으면 null을 반환한다.
 */
function getLatestValue(
  measurements: AtlasRawMeasurement[],
  name: string,
): number | null {
  const m = measurements.find(m => m.name === name)
  if (!m) return null
  const latest = [...m.dataPoints].reverse().find(dp => dp.value !== null)
  return latest?.value ?? null
}

/**
 * Atlas Metrics API 원시 응답(프로세스 + 디스크)을 NormalizedMetrics로 변환한다.
 *
 * 변환 규칙:
 *   - connections:      CONNECTIONS (직접)
 *   - cpuNormalizedPct: SYSTEM_NORMALIZED_CPU_USER + SYSTEM_NORMALIZED_CPU_KERNEL (합산)
 *   - memoryUsedPct:    SYSTEM_MEMORY_USED / (SYSTEM_MEMORY_USED + SYSTEM_MEMORY_AVAILABLE) × 100
 *   - diskUsedGb:       DISK_PARTITION_SPACE_USED bytes → GB 변환
 *   - diskQueueDepth:   DISK_QUEUE_DEPTH (직접)
 *   - readLatencyMs:    OP_EXECUTION_TIME_READS (직접)
 *   - writeLatencyMs:   OP_EXECUTION_TIME_WRITES (직접)
 *   - queryTargeting:   QUERY_TARGETING_SCANNED_OBJECTS_PER_RETURNED (직접)
 */
export function normalizeAtlasResponse(
  processMeasurements: AtlasRawMeasurement[],
  diskMeasurements:    AtlasRawMeasurement[],
): NormalizedMetrics {
  // ── 프로세스 레벨 메트릭 ─────────────────────────────────────────

  const connections   = getLatestValue(processMeasurements, 'CONNECTIONS') ?? 0
  const readLatencyMs = getLatestValue(processMeasurements, 'OP_EXECUTION_TIME_READS') ?? 0
  const writeLatencyMs = getLatestValue(processMeasurements, 'OP_EXECUTION_TIME_WRITES') ?? 0
  const queryTargeting = getLatestValue(processMeasurements, 'QUERY_TARGETING_SCANNED_OBJECTS_PER_RETURNED') ?? 0

  // CPU: user + kernel 합산 (normalized = 전체 코어 대비 %)
  const cpuUser   = getLatestValue(processMeasurements, 'SYSTEM_NORMALIZED_CPU_USER') ?? 0
  const cpuKernel = getLatestValue(processMeasurements, 'SYSTEM_NORMALIZED_CPU_KERNEL') ?? 0
  const cpuNormalizedPct = Math.min(100, cpuUser + cpuKernel)

  // 메모리: used / (used + available) × 100
  const memUsedKb  = getLatestValue(processMeasurements, 'SYSTEM_MEMORY_USED') ?? 0
  const memAvailKb = getLatestValue(processMeasurements, 'SYSTEM_MEMORY_AVAILABLE') ?? 0
  const memTotalKb = memUsedKb + memAvailKb
  const memoryUsedPct = memTotalKb > 0
    ? Math.min(100, (memUsedKb / memTotalKb) * 100)
    : 0

  // ── 디스크 레벨 메트릭 ───────────────────────────────────────────

  const diskQueueDepth = getLatestValue(diskMeasurements, 'DISK_QUEUE_DEPTH') ?? 0

  // DISK_PARTITION_SPACE_USED: bytes → GB
  const diskUsedBytes = getLatestValue(diskMeasurements, 'DISK_PARTITION_SPACE_USED') ?? 0
  const diskUsedGb = diskUsedBytes / 1_073_741_824

  return {
    connections:      Math.round(connections),
    cpuNormalizedPct: round1(cpuNormalizedPct),
    memoryUsedPct:    round1(memoryUsedPct),
    diskUsedGb:       round2(diskUsedGb),
    diskQueueDepth:   round2(diskQueueDepth),
    readLatencyMs:    round1(readLatencyMs),
    writeLatencyMs:   round1(writeLatencyMs),
    queryTargeting:   round1(queryTargeting),
  }
}

/**
 * 값에 소폭 노이즈를 추가한다. Mock 데이터를 자연스럽게 만들기 위해 사용한다.
 * @param value    기준값
 * @param noisePct 노이즈 비율 (기본 5% = ±5%)
 */
export function addNoise(value: number, noisePct = 0.05): number {
  const noise = value * noisePct * (Math.random() * 2 - 1)
  return Math.max(0, value + noise)
}

// ── 내부 헬퍼 ────────────────────────────────────────────────────
function round1(v: number): number { return Math.round(v * 10) / 10 }
function round2(v: number): number { return Math.round(v * 100) / 100 }

import { z } from 'zod'

// ── 필드 메타데이터 ───────────────────────────────────────────────
// 각 메트릭 필드의 단위·설명·허용 범위를 명시한다.
// Atlas Metrics API 원시 측정값 이름 → ATLAS_FIELD_MAP (packages/atlas/src/normalize.ts) 참고.

export interface MetricFieldMeta {
  /** 단위 (count, percent, gb, ms, ratio) */
  unit: string
  /** 필드 설명 */
  description: string
  /** 최솟값 (포함) */
  min: number
  /** 최댓값 (포함). null = 상한 없음 */
  max: number | null
  /** Atlas Metrics API 원시 측정값 이름 */
  atlasName: string
}

export const METRIC_FIELD_META: Record<keyof NormalizedMetrics, MetricFieldMeta> = {
  connections: {
    unit:        'count',
    description: '현재 활성 클라이언트 연결 수',
    min:         0,
    max:         null,
    atlasName:   'CONNECTIONS',
  },
  cpuNormalizedPct: {
    unit:        'percent',
    description: '전체 vCPU 대비 정규화된 CPU 사용률 (%)',
    min:         0,
    max:         100,
    atlasName:   'NORMALIZED_SYSTEM_CPU',
  },
  memoryUsedPct: {
    unit:        'percent',
    description: '전체 메모리 대비 사용률 (%)',
    min:         0,
    max:         100,
    atlasName:   'MEMORY_RESIDENT',
  },
  diskUsedGb: {
    unit:        'gb',
    description: '사용 중인 디스크 용량 (GB)',
    min:         0,
    max:         null,
    atlasName:   'DISK_SPACE_USED_DATA',
  },
  diskQueueDepth: {
    unit:        'count',
    description: '디스크 I/O 대기 큐 깊이 (평균)',
    min:         0,
    max:         null,
    atlasName:   'DISK_QUEUE_DEPTH',
  },
  readLatencyMs: {
    unit:        'ms',
    description: '읽기 작업 평균 지연 시간 (밀리초)',
    min:         0,
    max:         null,
    atlasName:   'OP_EXECUTION_TIME_READS',
  },
  writeLatencyMs: {
    unit:        'ms',
    description: '쓰기 작업 평균 지연 시간 (밀리초)',
    min:         0,
    max:         null,
    atlasName:   'OP_EXECUTION_TIME_WRITES',
  },
  queryTargeting: {
    unit:        'ratio',
    description: '반환된 문서당 스캔한 문서 수 (낮을수록 인덱스 효율이 높음)',
    min:         0,
    max:         null,
    atlasName:   'QUERY_TARGETING_SCANNED_OBJECTS_PER_RETURNED',
  },
}

/** 8개 메트릭 필드 이름 목록 (순서 보장) */
export const NORMALIZED_METRIC_FIELDS = Object.keys(
  METRIC_FIELD_META,
) as Array<keyof NormalizedMetrics>

// ── NormalizedMetrics 타입 + Zod 스키마 ──────────────────────────

export interface NormalizedMetrics {
  /** 현재 활성 클라이언트 연결 수 */
  connections: number
  /** 전체 vCPU 대비 정규화된 CPU 사용률 (0–100) */
  cpuNormalizedPct: number
  /** 전체 메모리 대비 사용률 (0–100) */
  memoryUsedPct: number
  /** 사용 중인 디스크 용량 (GB) */
  diskUsedGb: number
  /** 디스크 I/O 대기 큐 깊이 */
  diskQueueDepth: number
  /** 읽기 작업 평균 지연 시간 (ms) */
  readLatencyMs: number
  /** 쓰기 작업 평균 지연 시간 (ms) */
  writeLatencyMs: number
  /** 반환 문서당 스캔 문서 수 (높을수록 비효율) */
  queryTargeting: number
}

/**
 * NormalizedMetrics Zod 스키마
 * 런타임에서 필드 존재 여부 및 허용 범위를 검증한다.
 */
export const NormalizedMetricsSchema = z.object({
  connections:      z.number().int('connections must be an integer').nonnegative(),
  cpuNormalizedPct: z.number().min(0).max(100),
  memoryUsedPct:    z.number().min(0).max(100),
  diskUsedGb:       z.number().nonnegative(),
  diskQueueDepth:   z.number().nonnegative(),
  readLatencyMs:    z.number().nonnegative(),
  writeLatencyMs:   z.number().nonnegative(),
  queryTargeting:   z.number().nonnegative(),
})

// ── 유틸리티 함수 ─────────────────────────────────────────────────

/**
 * Zod 스키마로 메트릭 값을 검증한다.
 * 유효하지 않으면 ZodError를 던진다.
 */
export function validateMetrics(raw: unknown): NormalizedMetrics {
  return NormalizedMetricsSchema.parse(raw)
}

/**
 * 메트릭 값을 허용 범위 안으로 클램핑한다.
 * - 음수 값을 0으로 보정
 * - cpuNormalizedPct / memoryUsedPct를 0–100으로 제한
 * - connections를 정수로 반올림
 * - NaN / Infinity를 0으로 대체
 *
 * 어댑터가 비정상 값을 반환해도 안전하게 저장할 수 있도록 보장한다.
 */
export function clampMetrics(m: NormalizedMetrics): NormalizedMetrics {
  return {
    connections:      Math.round(clamp(m.connections, 0, null)),
    cpuNormalizedPct: round2(clamp(m.cpuNormalizedPct, 0, 100)),
    memoryUsedPct:    round2(clamp(m.memoryUsedPct,    0, 100)),
    diskUsedGb:       round2(clamp(m.diskUsedGb,       0, null)),
    diskQueueDepth:   round3(clamp(m.diskQueueDepth,   0, null)),
    readLatencyMs:    round2(clamp(m.readLatencyMs,    0, null)),
    writeLatencyMs:   round2(clamp(m.writeLatencyMs,   0, null)),
    queryTargeting:   round2(clamp(m.queryTargeting,   0, null)),
  }
}

// ── MetricsDocument ───────────────────────────────────────────────

export interface MetricsDocument {
  timestamp: Date
  meta: {
    projectId:   string
    clusterName: string
    source:      string
    metricGroup: string
  }
  metrics: NormalizedMetrics
}

// ── 내부 헬퍼 ────────────────────────────────────────────────────

function clamp(v: number, min: number, max: number | null): number {
  if (!isFinite(v) || isNaN(v)) return min
  const lo = Math.max(v, min)
  return max !== null ? Math.min(lo, max) : lo
}

function round2(v: number): number { return Math.round(v * 100) / 100 }
function round3(v: number): number { return Math.round(v * 1000) / 1000 }

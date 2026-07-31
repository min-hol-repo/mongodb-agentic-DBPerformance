import { createHash, randomBytes } from 'node:crypto'
import type { MetricsAdapter, MetricsAdapterResult } from './adapter.js'
import { AdapterUnavailableError, MetricsCollectionError } from './errors.js'
import {
  normalizeAtlasResponse,
  type AtlasRawMeasurement,
} from './normalize.js'

export interface AtlasMCPAdapterOptions {
  projectId:  string
  publicKey:  string
  privateKey: string
  /** Atlas API 기본 URL. 기본값: https://cloud.mongodb.com */
  baseUrl?: string
}

// ── HTTP Digest 인증 ──────────────────────────────────────────────

interface DigestChallenge {
  realm:     string
  nonce:     string
  qop:       string | undefined
  algorithm: string
  opaque:    string | undefined
}

/** WWW-Authenticate 헤더를 파싱하여 Digest 챌린지를 반환한다. */
function parseWwwAuthenticate(header: string): DigestChallenge {
  const get = (key: string): string | undefined => {
    const m = header.match(new RegExp(`${key}="([^"]*)"`, 'i'))
    return m?.[1]
  }
  return {
    realm:     get('realm')     ?? '',
    nonce:     get('nonce')     ?? '',
    qop:       get('qop'),
    algorithm: get('algorithm') ?? 'MD5',
    opaque:    get('opaque'),
  }
}

function md5(s: string): string {
  return createHash('md5').update(s).digest('hex')
}

/**
 * HTTP Digest 인증으로 GET 요청을 수행한다.
 *
 * 흐름:
 *   1. 첫 요청 → 401 + WWW-Authenticate
 *   2. Digest 해시 계산
 *   3. Authorization 헤더를 붙여 재요청 → 실제 응답 반환
 */
async function digestFetch(
  url:      string,
  username: string,
  password: string,
  headers:  Record<string, string> = {},
): Promise<Response> {
  // 1차 요청 — 챌린지 획득
  const first = await fetch(url, { headers })

  if (first.status !== 401) return first

  const wwwAuth = first.headers.get('www-authenticate') ?? ''
  if (!wwwAuth.toLowerCase().startsWith('digest')) return first

  const ch = parseWwwAuthenticate(wwwAuth)
  const nc = '00000001'
  const cnonce = randomBytes(8).toString('hex')
  const method = 'GET'
  const uri = new URL(url).pathname + new URL(url).search

  const ha1 = md5(`${username}:${ch.realm}:${password}`)
  const ha2 = md5(`${method}:${uri}`)

  let response: string
  if (ch.qop === 'auth') {
    response = md5(`${ha1}:${ch.nonce}:${nc}:${cnonce}:${ch.qop}:${ha2}`)
  } else {
    response = md5(`${ha1}:${ch.nonce}:${ha2}`)
  }

  const parts = [
    `username="${username}"`,
    `realm="${ch.realm}"`,
    `nonce="${ch.nonce}"`,
    `uri="${uri}"`,
    `response="${response}"`,
  ]
  if (ch.qop)    parts.push(`qop=${ch.qop}`, `nc=${nc}`, `cnonce="${cnonce}"`)
  if (ch.opaque) parts.push(`opaque="${ch.opaque}"`)

  const authHeader = `Digest ${parts.join(', ')}`

  // 2차 요청 — 실제 데이터 수신
  return fetch(url, {
    headers: { ...headers, Authorization: authHeader },
  })
}

// ── Atlas Admin API 응답 타입 ──────────────────────────────────────

interface AtlasProcess {
  id:             string   // "host:port"
  typeName:       string   // "REPLICA_PRIMARY" | "REPLICA_SECONDARY" | ...
  replicaSetName: string
  hostname:       string
}

interface AtlasProcessesResponse {
  results: AtlasProcess[]
}

interface AtlasMeasurementsResponse {
  measurements: AtlasRawMeasurement[]
}

interface AtlasDiskPartition {
  partitionName: string
}

interface AtlasDisksResponse {
  results: AtlasDiskPartition[]
}

// ── AtlasMetricsMCPAdapter ────────────────────────────────────────

/**
 * Atlas Admin API v2를 통해 실제 클러스터 메트릭을 수집하는 어댑터.
 *
 * 수집 흐름:
 *   1. GET /groups/{projectId}/processes
 *      → clusterName을 포함하는 PRIMARY 노드의 processId(host:port) 식별
 *   2. GET /groups/{projectId}/processes/{processId}/measurements
 *      → 프로세스 레벨 메트릭 7개 (CPU, 메모리, 커넥션 등)
 *   3. GET /groups/{projectId}/processes/{processId}/disks
 *      → 첫 번째 파티션 이름 획득
 *   4. GET /groups/{projectId}/processes/{processId}/disks/{partition}/measurements
 *      → 디스크 레벨 메트릭 2개 (큐 깊이, 사용량)
 *   5. normalizeAtlasResponse(process, disk) → NormalizedMetrics
 *
 * 인증: HTTP Digest (publicKey:privateKey)
 */
export class AtlasMetricsMCPAdapter implements MetricsAdapter {
  readonly name = 'atlas-mcp'

  private readonly projectId:  string
  private readonly publicKey:  string
  private readonly privateKey: string
  private readonly baseUrl:    string

  /** 프로세스 ID 캐시 (clusterName → processId) */
  private processIdCache = new Map<string, string>()

  /** 디스크 파티션 캐시 (processId → partitionName) */
  private partitionCache = new Map<string, string>()

  constructor(opts: AtlasMCPAdapterOptions) {
    if (!opts.projectId)  throw new Error('AtlasMetricsMCPAdapter: projectId is required')
    if (!opts.publicKey)  throw new Error('AtlasMetricsMCPAdapter: publicKey is required')
    if (!opts.privateKey) throw new Error('AtlasMetricsMCPAdapter: privateKey is required')

    this.projectId  = opts.projectId
    this.publicKey  = opts.publicKey
    this.privateKey = opts.privateKey
    this.baseUrl    = opts.baseUrl ?? 'https://cloud.mongodb.com'
  }

  // ── 공개 메서드 ─────────────────────────────────────────────────

  async isAvailable(): Promise<boolean> {
    try {
      const url = `${this.baseUrl}/api/atlas/v2/groups/${this.projectId}`
      const res = await this.get(url)
      return res.ok
    } catch {
      return false
    }
  }

  async collect(clusterName: string): Promise<MetricsAdapterResult> {
    try {
      const processId = await this.resolveProcessId(clusterName)
      const [processMeasurements, diskMeasurements] = await Promise.all([
        this.fetchProcessMeasurements(processId),
        this.fetchDiskMeasurements(processId),
      ])

      const metrics = normalizeAtlasResponse(processMeasurements, diskMeasurements)

      return {
        clusterName,
        projectId: this.projectId,
        source:    'atlas-mcp',
        timestamp: new Date(),
        metrics,
      }
    } catch (err) {
      if (err instanceof AdapterUnavailableError) throw err
      throw new MetricsCollectionError(clusterName, err)
    }
  }

  // ── 내부 메서드 ─────────────────────────────────────────────────

  /** Digest 인증이 적용된 GET 요청 */
  private async get(url: string): Promise<Response> {
    return digestFetch(url, this.publicKey, this.privateKey, {
      Accept: 'application/vnd.atlas.2023-01-01+json',
    })
  }

  /** Atlas API 응답을 파싱하고 오류가 있으면 예외를 던진다. */
  private async parseJson<T>(res: Response, context: string): Promise<T> {
    const body = await res.json() as Record<string, unknown>
    if (!res.ok) {
      const msg = (body['detail'] as string | undefined)
        ?? (body['reason'] as string | undefined)
        ?? `HTTP ${res.status}`
      throw new AdapterUnavailableError(this.name, `${context}: ${msg}`)
    }
    return body as T
  }

  /**
   * clusterName을 포함하는 PRIMARY 프로세스의 ID(host:port)를 반환한다.
   * 재시작 시에도 캐시를 재활용하며, 캐시 미스 시 API를 호출한다.
   */
  private async resolveProcessId(clusterName: string): Promise<string> {
    const cached = this.processIdCache.get(clusterName)
    if (cached) return cached

    const url = `${this.baseUrl}/api/atlas/v2/groups/${this.projectId}/processes`
    const res = await this.get(url)
    const data = await this.parseJson<AtlasProcessesResponse>(res, 'processes')

    // clusterName을 포함하는 PRIMARY 노드 우선, 없으면 첫 번째 노드 사용
    const primary = data.results.find(p =>
      p.replicaSetName.toLowerCase().includes(clusterName.toLowerCase()) &&
      p.typeName === 'REPLICA_PRIMARY',
    ) ?? data.results.find(p =>
      p.replicaSetName.toLowerCase().includes(clusterName.toLowerCase()),
    ) ?? data.results[0]

    if (!primary) {
      throw new AdapterUnavailableError(
        this.name,
        `No process found for cluster '${clusterName}' in project '${this.projectId}'`,
      )
    }

    this.processIdCache.set(clusterName, primary.id)
    return primary.id
  }

  /**
   * 프로세스 레벨 메트릭을 수집한다.
   * m= 파라미터 없이 전체 메트릭을 요청한다.
   * (일부 메트릭은 명시 지정 시 BAD_REQUEST를 반환하므로 전체 조회 후 파싱)
   */
  private async fetchProcessMeasurements(processId: string): Promise<AtlasRawMeasurement[]> {
    const params = new URLSearchParams({
      granularity: 'PT1M',
      period:      'PT5M',
    })

    const url = `${this.baseUrl}/api/atlas/v2/groups/${this.projectId}/processes/${processId}/measurements?${params}`
    const res  = await this.get(url)
    const data = await this.parseJson<AtlasMeasurementsResponse>(res, 'process measurements')
    return data.measurements ?? []
  }

  /**
   * 디스크 파티션 이름을 조회하고 디스크 레벨 메트릭을 수집한다.
   * 파티션 이름은 캐시하여 반복 호출을 줄인다.
   */
  private async fetchDiskMeasurements(processId: string): Promise<AtlasRawMeasurement[]> {
    let partition = this.partitionCache.get(processId)

    if (!partition) {
      const disksUrl = `${this.baseUrl}/api/atlas/v2/groups/${this.projectId}/processes/${processId}/disks`
      const disksRes = await this.get(disksUrl)
      const disksData = await this.parseJson<AtlasDisksResponse>(disksRes, 'disks')

      if (!disksData.results?.length) {
        console.warn(`[atlas-mcp] No disk partitions found for process ${processId}`)
        return []
      }

      partition = disksData.results[0]!.partitionName
      this.partitionCache.set(processId, partition)
    }

    const params = new URLSearchParams({
      granularity: 'PT1M',
      period:      'PT5M',
    })
    // m= 파라미터 없이 전체 조회 후 normalizeAtlasResponse 에서 필요한 것만 추출

    const url = `${this.baseUrl}/api/atlas/v2/groups/${this.projectId}/processes/${processId}/disks/${partition}/measurements?${params}`
    const res  = await this.get(url)
    const data = await this.parseJson<AtlasMeasurementsResponse>(res, 'disk measurements')
    return data.measurements ?? []
  }
}

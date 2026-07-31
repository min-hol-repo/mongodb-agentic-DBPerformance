import { MongoClient, ServerApiVersion, type Db } from 'mongodb'

// ── 설정 ──────────────────────────────────────────────────────────
export interface DbConfig {
  uri: string
  dbName: string
}

export function getDbConfig(): DbConfig {
  const uri = process.env.MONGODB_URI ?? ''
  const dbName = process.env.MONGODB_DB_NAME ?? 'agentic_demo'
  return { uri, dbName }
}

// ── 싱글턴 연결 ──────────────────────────────────────────────────
let _client: MongoClient | null = null
let _db: Db | null = null

/**
 * 데이터베이스 인스턴스를 반환한다.
 * 첫 호출 시 연결을 맺고, 이후 호출에서는 캐시된 인스턴스를 반환한다.
 */
export async function getDb(): Promise<Db> {
  if (_db) return _db

  const { uri, dbName } = getDbConfig()

  if (!uri) {
    throw new Error(
      'MONGODB_URI environment variable is not set. ' +
      'Copy .env.example to .env and set the value.',
    )
  }

  _client = new MongoClient(uri, {
    // Atlas Stable API — 버전 간 호환성 보장
    serverApi: {
      version: ServerApiVersion.v1,
      strict: false,          // 일부 명령어(createCollection 등) 허용
      deprecationErrors: true,
    },
    // 연결 타임아웃
    connectTimeoutMS: 10_000,
    socketTimeoutMS: 45_000,
    serverSelectionTimeoutMS: 10_000,
    // 연결 풀 (데모용 보수적 설정)
    maxPoolSize: 10,
    minPoolSize: 1,
    // 재시도
    retryWrites: true,
    retryReads: true,
  })

  await _client.connect()
  _db = _client.db(dbName)

  console.log(`[db] Connected → ${dbName}`)
  return _db
}

/**
 * 연결을 닫는다. 프로세스 종료 시 호출한다.
 */
export async function closeDb(): Promise<void> {
  if (_client) {
    await _client.close()
    _client = null
    _db = null
    console.log('[db] Connection closed')
  }
}

/**
 * 현재 연결 상태를 반환한다.
 */
export function isConnected(): boolean {
  return _db !== null
}

/**
 * 테스트 전용: 외부에서 주입된 클라이언트로 교체한다.
 * 프로덕션 코드에서는 사용하지 않는다.
 */
export function _injectDb(client: MongoClient, db: Db): void {
  _client = client
  _db = db
}

/**
 * 테스트 전용: 싱글턴을 초기화한다.
 */
export function _resetDb(): void {
  _client = null
  _db = null
}

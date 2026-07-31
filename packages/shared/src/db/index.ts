export { getDb, closeDb, isConnected, getDbConfig, _injectDb, _resetDb } from './client.js'
export { ensureCollections } from './collections.js'
export { COLLECTIONS, type CollectionName } from './collection-names.js'
export * from './repositories/index.js'
// mongodb Db 타입을 re-export — 의존 패키지가 mongodb를 직접 의존하지 않아도 됨
export type { Db } from 'mongodb'

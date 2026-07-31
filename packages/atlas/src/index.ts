export type { MetricsAdapter, MetricsAdapterResult } from './adapter.js'
export { AdapterUnavailableError, MetricsCollectionError } from './errors.js'
export {
  EMPTY_METRICS,
  normalizeAtlasResponse,
  addNoise,
  type AtlasRawMeasurement,
  type AtlasDataPoint,
} from './normalize.js'
export {
  MockMetricsAdapter,
  getScenarioBaseline,
  type MockScenario,
  type MockMetricsAdapterOptions,
} from './mock.js'
export {
  AtlasMetricsMCPAdapter,
  type AtlasMCPAdapterOptions,
} from './mcp.js'
export { createAdapterFromEnv, type AdapterType } from './factory.js'

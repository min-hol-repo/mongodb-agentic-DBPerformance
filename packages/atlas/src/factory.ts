import { MockMetricsAdapter, type MockScenario } from './mock.js'
import { AtlasMetricsMCPAdapter } from './mcp.js'
import type { MetricsAdapter } from './adapter.js'

export type AdapterType = 'mock' | 'mcp'

/**
 * 환경변수를 읽어 적절한 어댑터 인스턴스를 생성한다.
 *
 * 환경변수:
 *   COLLECTOR_ADAPTER         어댑터 타입 ('mock' | 'mcp'). 기본값: 'mock'
 *   COLLECTOR_MOCK_SCENARIO   mock 시나리오. 기본값: 'normal'
 *   ATLAS_PROJECT_ID          mcp 어댑터용 프로젝트 ID
 *   ATLAS_PUBLIC_KEY          mcp 어댑터용 공개 키
 *   ATLAS_PRIVATE_KEY         mcp 어댑터용 비밀 키
 */
export function createAdapterFromEnv(): MetricsAdapter {
  const type = (process.env.COLLECTOR_ADAPTER ?? 'mock') as AdapterType

  switch (type) {
    case 'mock': {
      const scenario = (process.env.COLLECTOR_MOCK_SCENARIO ?? 'normal') as MockScenario
      console.log(`[atlas] Using mock adapter (scenario: ${scenario})`)
      return new MockMetricsAdapter({ scenario })
    }

    case 'mcp': {
      const projectId  = process.env.ATLAS_PROJECT_ID  ?? ''
      const publicKey  = process.env.ATLAS_PUBLIC_KEY  ?? ''
      const privateKey = process.env.ATLAS_PRIVATE_KEY ?? ''

      if (!projectId || !publicKey || !privateKey) {
        console.warn(
          '[atlas] MCP adapter requested but ATLAS_PROJECT_ID / ATLAS_PUBLIC_KEY / ' +
          'ATLAS_PRIVATE_KEY are not set. Falling back to mock adapter.',
        )
        return new MockMetricsAdapter()
      }

      console.log('[atlas] Using Atlas Metrics MCP adapter')
      return new AtlasMetricsMCPAdapter({ projectId, publicKey, privateKey })
    }

    default: {
      console.warn(`[atlas] Unknown adapter type '${type}', falling back to mock`)
      return new MockMetricsAdapter()
    }
  }
}

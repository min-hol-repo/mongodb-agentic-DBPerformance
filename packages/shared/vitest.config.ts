import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    testTimeout: 30_000,  // mongodb-memory-server 기동 시간 여유
    hookTimeout: 30_000,
  },
})

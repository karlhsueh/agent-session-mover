import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: process.env.AGENT_SESSIONS_REAL ? ['test/real/**/*.real.test.ts'] : ['test/**/*.test.ts'],
    exclude: process.env.AGENT_SESSIONS_REAL ? [] : ['test/real/**', '**/node_modules/**'],
    environment: 'node',
  },
})

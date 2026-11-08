import { defineConfig } from 'vitest/config'

const suite = process.env.AGENT_SESSIONS_REAL ? 'real' : process.env.AGENT_SESSIONS_E2E ? 'e2e' : 'unit'
const include = { real: ['test/real/**/*.real.test.ts'], e2e: ['test/e2e/**/*.e2e.test.ts'], unit: ['test/**/*.test.ts'] }[suite]

export default defineConfig({
  test: {
    include,
    exclude: suite === 'unit' ? ['test/real/**', 'test/e2e/**', '**/node_modules/**'] : ['**/node_modules/**'],
    environment: 'node',
  },
})

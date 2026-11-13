import { defineConfig } from 'vitest/config'

// Unit tests run without models, databases or Electron: pure logic only.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.ts'],
  },
})

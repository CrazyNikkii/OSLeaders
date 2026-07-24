import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    clearMocks: true,
    environment: 'node',
    fileParallelism: false,
    include: ['test/integration/**/*.test.ts'],
    mockReset: true,
    passWithNoTests: false,
    restoreMocks: true,
  },
});

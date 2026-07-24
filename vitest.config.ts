import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    clearMocks: true,
    environment: 'node',
    include: ['test/**/*.test.ts'],
    mockReset: true,
    passWithNoTests: false,
    restoreMocks: true,
  },
});

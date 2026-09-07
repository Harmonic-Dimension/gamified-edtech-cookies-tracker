import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 240_000,
    hookTimeout: 120_000,
    // Browser-driven tests must not run concurrently with each other.
    fileParallelism: false,
  },
});

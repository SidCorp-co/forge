import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'src/**/*.test.ts',
      'tests/helpers/**/*.test.ts',
      '../contracts/src/**/*.test.ts',
      '../../scripts/**/*.test.mjs',
    ],
    environment: 'node',
    hookTimeout: 60_000,
    testTimeout: 20_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts'],
    },
  },
});

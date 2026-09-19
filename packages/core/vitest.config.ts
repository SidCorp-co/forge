import { defineConfig } from 'vitest/config';
import { testWorkers } from '../../scripts/lib/test-workers.mjs';

export default defineConfig({
  test: {
    maxWorkers: testWorkers({ share: 3, min: 2 }),
    include: [
      'src/**/*.test.ts',
      'tests/helpers/**/*.test.ts',
      '../contracts/src/**/*.test.ts',
      '../../scripts/**/*.test.mjs',
    ],
    environment: 'node',
    // cm:flow step is defended, and a cache on that path is a silent way to degrade a gate.
    fsModuleCache: true,
    // See vitest.setup.ts — the three required env vars, so a unit test whose subject is a pure
    // function does not have to mock the env module to reach a populated integration registry.
    setupFiles: ['./vitest.setup.ts'],
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

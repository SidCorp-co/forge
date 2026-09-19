import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';
import { testWorkers } from '../../scripts/lib/test-workers.mjs';

// vitest config for web-v2's unit suite. The `@/` alias mirrors tsconfig `paths`
// so feature modules resolve the same way under test as under `next build`.
//
// This said "pure feature logic — no DOM" until 2026-09-17, which stopped being
// true some time before: 81 files under `src/` open with
// `// @vitest-environment jsdom` and render React through testing-library. The
// default `environment` below is still `node`, so those files each opt in for
// themselves; what was wrong was the sentence, not the setting.
export default defineConfig({
  resolve: {
    alias: { '@': resolve(__dirname, 'src') },
  },
  test: {
    maxWorkers: testWorkers({ share: 3, min: 2 }),
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}'],
    testTimeout: 20_000,
    setupFiles: ['./src/vitest.setup.ts'],
  },
});

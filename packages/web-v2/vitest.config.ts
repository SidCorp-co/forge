import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

// vitest config for web-v2's unit suite. The `@/` alias mirrors tsconfig `paths`
// so feature modules resolve the same way under test as under `next build`.
//
// This said "pure feature logic — no DOM" until 2026-09-16, which stopped being
// true some time before: 79 files under `src/` open with
// `// @vitest-environment jsdom` and render React through testing-library. The
// default `environment` below is still `node`, so those files each opt in for
// themselves; what was wrong was the sentence, not the setting.
//
// `testTimeout` is 20s rather than vitest's 5s default because this suite runs
// under `pnpm test` alongside core's fork pool, and a fully synchronous render
// test crossed 5s on a loaded box. It is a CONTENTION budget, not a correctness
// one. Note that it does not cover testing-library's own async utilities:
// `findBy*` and `waitFor` carry a separate 1000ms `asyncUtilTimeout` that
// nothing here raises, which is why a render that has not settled reports
// "Unable to find role=..." rather than a vitest timeout.
export default defineConfig({
  resolve: {
    alias: { '@': resolve(__dirname, 'src') },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}'],
    testTimeout: 20_000,
  },
});

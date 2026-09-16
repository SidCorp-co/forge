import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

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
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}'],
    // cm:guard this suite mounts real React trees, so the default 5s is a CONTENTION budget, not a correctness one — under `pnpm test` (turbo runs core's fork pool alongside) a fully synchronous render test took 7.3s and timed out, and it passes in 2s standalone. Measured 2026-08-14 on `pipeline-preserve-on-save.test.tsx`. Lowering this back re-introduces a flake that looks like a web-v2 regression and is not one. It does NOT cover testing-library's own async utilities: `findBy*` and `waitFor` carry a separate 1000ms `asyncUtilTimeout` that nothing here raises, which is why a render that has not settled under contention reports `Unable to find role=...` rather than a vitest timeout — measured 2026-09-16 on `conversations-screen.test.tsx`, which failed 2 of 6 full runs and passes 5 of 5 standalone.
    testTimeout: 20_000,
  },
});

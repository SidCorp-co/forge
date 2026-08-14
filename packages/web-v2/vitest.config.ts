import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

// Minimal vitest config for web-v2 unit tests (pure feature logic — no DOM).
// The `@/` alias mirrors tsconfig `paths` so feature modules resolve the same
// way under test as under `next build`.
export default defineConfig({
  resolve: {
    alias: { '@': resolve(__dirname, 'src') },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}'],
    // cm:guard this suite mounts real React trees, so the default 5s is a CONTENTION budget, not a correctness one — under `pnpm test` (turbo runs core's fork pool alongside) a fully synchronous render test took 7.3s and timed out, and it passes in 2s standalone. Measured 2026-08-14 on `pipeline-preserve-on-save.test.tsx`. Lowering this back re-introduces a flake that looks like a web-v2 regression and is not one.
    testTimeout: 20_000,
  },
});

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // cm:why `packages/contracts` declares no test script and no vitest config, so its only test file ran NOWHERE — not in `pnpm test`, not in CI's `pnpm --filter @forge/core test`. Included from here rather than given a runner of its own because contracts is a type-only surface whose one behavioural unit (the kernel↔label map) is consumed by core.
    // cm:why `scripts/` has no runner of its own and the gate scripts are where this repo's rules live — the baseline-ratchet comparators decide whether five frozen baselines may grow, and until this line they were verified only by hand
    // cm:why `tests/helpers/` is collected HERE rather than by the integration config: those helpers carry real logic (the scratch-database naming and the age reaper that decides what may be dropped from a shared server), and the integration config's `globalSetup` needs a live Postgres — so a unit test placed there could not run without the very database it exists to keep safe
    include: [
      'src/**/*.test.ts',
      'tests/helpers/**/*.test.ts',
      '../contracts/src/**/*.test.ts',
      '../../scripts/**/*.test.mjs',
    ],
    environment: 'node',
    // cm:guard measured on THIS suite before it was kept, twice in each direction and alternated so a
    // drifting box could not favour one side: off 33.38s / 32.96s, on 25.96s / 25.60s, both `on` runs
    // taken at a HIGHER load average than both `off` runs. The transform share is where it comes from
    // — 43% off, 16% on — because the cache persists transformed modules on disk and a repeat run
    // skips them. `vitest doctor` recommends it at -16%; this suite gets -22% (ISS-1067).
    // cm:guard NOT set in vitest.integration.config.ts. That config produces the coverage report
    // `scripts/check-flow-coverage.mjs --require-sources` treats as AUTHORITATIVE evidence that a
    // cm:flow step is defended, and a cache on that path is a silent way to degrade a gate.
    fsModuleCache: true,
    // See vitest.setup.ts — the three required env vars, so a unit test whose subject is a pure
    // function does not have to mock the env module to reach a populated integration registry.
    setupFiles: ['./vitest.setup.ts'],
    hookTimeout: 60_000,
    // cm:why vitest's 5s default assumes a test body does only assertions; here a test's first touch of a mocked module pays the module-graph load, and under 8-way parallelism on a loaded box that crossed 5s — the sole cause of the two long-standing "flaky" files
    testTimeout: 20_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts'],
    },
  },
});

import { defineConfig } from 'vitest/config';

/**
 * Typecheck mode is ON for this package, and that is the whole reason this file exists.
 *
 * `integration-binding-shape.test.ts` asserts what a typed caller may NOT write, and
 * `@ts-expect-error` IS the assertion: the line fails when the error it expects stops happening.
 * `typecheck` covers the source only (tsconfig.json excludes `*.test.ts`), so this run is what
 * compiles the test files, against tsconfig.test.json. A `@ts-expect-error` that had stopped
 * expecting anything would otherwise go on printing a green.
 *
 * `include` names the ordinary test files rather than the `*.test-d.ts` default, because these
 * assertions live beside runtime ones in the same file — the shape a caller may declare and the
 * shape it may not are one subject.
 */
export default defineConfig({
  test: {
    // The guard fails a test that lists the repository root without declaring it (ISS-1314).
    setupFiles: ['../../scripts/lib/whole-tree-guard.mjs'],
    typecheck: {
      enabled: true,
      include: ['src/**/*.test.ts'],
      tsconfig: './tsconfig.test.json',
    },
  },
});

import { defineConfig } from 'vitest/config';

/**
 * Typecheck mode is ON for this package, and that is the whole reason this file exists.
 *
 * `integration-binding-shape.test.ts` asserts what a typed caller may NOT write, and
 * `@ts-expect-error` IS the assertion: the line fails when the error it expects stops happening.
 * Nothing was compiling it. CI runs `pnpm --filter @forge/contracts test` and nothing else for
 * this package; `build` is `tsc --noEmit` against a tsconfig that EXCLUDES `*.test.ts`, and no job
 * runs `typecheck` at all. A `@ts-expect-error` that had stopped expecting anything would have
 * gone on printing a green.
 *
 * `include` names the ordinary test files rather than the `*.test-d.ts` default, because these
 * assertions live beside runtime ones in the same file — the shape a caller may declare and the
 * shape it may not are one subject.
 */
export default defineConfig({
  test: {
    typecheck: {
      enabled: true,
      include: ['src/**/*.test.ts'],
      tsconfig: './tsconfig.json',
    },
  },
});

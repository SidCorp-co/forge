// Type-only augmentation of vitest's `expect` with jest-dom matchers
// (toBeDisabled, toBeInTheDocument, ...). A .d.ts file is never emitted or
// executed, so this is purely a compile-time declaration merge — unlike
// importing the `@testing-library/jest-dom/vitest` runtime entry, it can't
// double-extend `expect` under pnpm hoisting (see the note in
// awaiting-release-card.test.tsx). Runtime registration still happens per
// test file via `expect.extend(matchers)`.
import type { TestingLibraryMatchers } from "@testing-library/jest-dom/matchers";

declare module "vitest" {
  interface Assertion<T = unknown> extends TestingLibraryMatchers<unknown, T> {}
  interface AsymmetricMatchersContaining extends TestingLibraryMatchers<unknown, void> {}
}

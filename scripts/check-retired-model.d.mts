/**
 * Types for the two pieces of `check-retired-model.mjs` that its test imports.
 *
 * The checker is plain ESM, like every other script here, and stays that way: it runs from
 * `pnpm verify` and from CI with no build step. This declaration exists so the test that holds
 * its rules honest can be written in TypeScript without an `any`, which would have made the
 * rule's own shape invisible at exactly the place the test is about.
 */

/** One retired shape the audit hunts, with the sentence a reader gets when it fires. */
export interface RetiredModelRule {
  id: string;
  re: RegExp;
  why: string;
}

export declare const RULES: RetiredModelRule[];

/** Blank out comments, and only comments, leaving every other byte and every newline in place. */
export declare function stripComments(src: string): string;

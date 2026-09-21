export interface RetiredModelRule {
  id: string;
  re: RegExp;
  why: string;
}

export declare const RULES: RetiredModelRule[];

/** Blank out comments, and only comments, leaving every other byte and every newline in place. */
export declare function stripComments(src: string): string;

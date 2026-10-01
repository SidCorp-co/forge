export interface RetiredModelRule {
  id: string;
  re: RegExp;
  why: string;
  exts?: string[];
  allow?: RegExp[];
}

export declare const RULES: RetiredModelRule[];

/** Blank out comments, and only comments, leaving every other byte and every newline in place. */
export declare function stripComments(src: string): string;

export interface AllowedLine {
  file: string;
  rule: string;
  text: string;
  why: string;
}

export declare const ALLOW_LINES: AllowedLine[];

/** Whether `line` of `file` is the one exact line `ALLOW_LINES` lets past rule `ruleId`. */
export declare function lineAllowed(file: string, ruleId: string, line: string): boolean;

export interface RetiredModelFinding {
  file: string;
  line: number;
  rule: string;
  text: string;
  why: string;
}

/** Every finding in `src`, read as the repository file `rel`, with every allowance applied. */
export declare function scanSource(rel: string, src: string): RetiredModelFinding[];

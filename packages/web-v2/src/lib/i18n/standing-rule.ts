import type { ProductCopyKey } from "./product-copy";

// One pattern of core's English: the shape of the sentence, the locale key it reads as, and the
// names it carries over (`standing-copy.ts` applies them).

export type Vars = Record<string, string | number>;

export interface Rule {
  re: RegExp;
  key: ProductCopyKey;
  /** Null where a part the pattern captured is itself one no pattern names: the sentence then reads as core wrote it. */
  vars?: (groups: Record<string, string>, language: string) => Vars | null;
}

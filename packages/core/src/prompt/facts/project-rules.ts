import type { AlwaysInjectFact } from '../../knowledge/index.js';

/**
 * A project's `injection: 'always'` knowledge entries, rendered verbatim under one heading: the block
 * every core-built preamble carries (`resolve.ts:renderStageFactsText`) and the orientation a box
 * writes into a checkout (`checkout-orientation.ts:checkoutOrientation`), so a run a master declares
 * on a box reads the same rules a pipeline step does (REQ-43 BC-12). `depth` is the heading level of
 * the block; each entry sits one level below it, under its slug.
 */
export function projectRulesText(
  entries: readonly AlwaysInjectFact[],
  depth: 2 | 3,
  restatedBy: ReadonlyMap<string, string> = new Map(),
): string {
  const heading = '#'.repeat(depth);
  // a rule a working agreement restates is that agreement's detail, never a second instruction (REQ-90)
  const head = (key: string) => {
    const agreement = restatedBy.get(key);
    return agreement ? `${key} (detail of the working agreement ${agreement})` : key;
  };
  return [
    `${heading} Project rules (always applied)`,
    'Hard rules for this project — always-injected by the project owner. Follow them exactly.',
    ...entries.map((f) => `${heading}# ${head(f.key)}\n${f.text}`),
  ].join('\n\n');
}

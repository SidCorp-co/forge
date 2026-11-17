import { ALWAYS_INJECT_MAX_CHARS, alwaysPastCap } from '@forge/contracts/knowledge';
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
  // past the cap the rules are served whole and said, never cut, until the steward's merge lands (ISS-1251 c5)
  const past = alwaysPastCap(entries);
  const size = entries.reduce((n, f) => n + f.text.length, 0);
  return [
    `${heading} Project rules (always applied)`,
    'Hard rules for this project — always-injected by the project owner. Follow them exactly.',
    ...(past.length > 0
      ? [
          `Past their ${ALWAYS_INJECT_MAX_CHARS}-character cap: these rules are ${size} characters, from ${past[0]?.key} on (${past.length} of ${entries.length}), served whole until the steward's merge lands.`,
        ]
      : []),
    ...entries.map((f) => `${heading}# ${head(f.key)}\n${f.text}`),
  ].join('\n\n');
}

// How Forge's own words on a Needs you decision call the records it names (ISS-680 c5, REQ-68 BC-1:
// each thing said once). The requirement a decision opens is named by its evidence, once, with its key,
// revision and title, so the decision's sentences call it "the requirement".

import type { DecisionOpens } from '@forge/contracts/needs-you-decisions';

/**
 * What Forge's own words on a decision call a record (ISS-680 c5): the requirement the decision opens
 * is "the requirement", since its evidence names it once, by key, revision and title
 * (`needs-you-evidence.ts:withEvidence`), and every screen draws that; any other record by its key.
 * The asker's words are theirs, and are never rewritten.
 */
export const nameOf = (opens: DecisionOpens | null | undefined, key: string): string =>
  opens?.kind === 'requirement' && opens.key === key ? 'the requirement' : key;

/** `nameOf`, opening a sentence. */
export const NameOf = (opens: DecisionOpens | null | undefined, key: string): string => {
  const named = nameOf(opens, key);
  return `${named.charAt(0).toUpperCase()}${named.slice(1)}`;
};

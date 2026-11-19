// How each New and Fixed line's call to an outside provider was proven (ISS-1329): what its judges
// said on their verdicts (`integrationProof`), never what core guessed from evidence text. A master
// asked for production approval of an integration that had run only against a mock, and its release
// said nothing of it; a line now reads `simulated` while any of its issue's criteria rests on a mock.

import type { IntegrationProof, ReleasePage } from '@forge/contracts/release-page';
import type { ReleaseRecord, WeighedIssue } from '../release-batch/index.js';

type Change = ReleasePage['improvements'][number];
type Changes = { improvements: Change[]; fixes: Change[] };

/**
 * Each issue's outside-call proof, by issue id: the newest saying of each live criterion, `simulated`
 * where any is, else `live`. A verdict that says nothing keeps the saying before it, so a re-judge
 * restating a pass does not wipe it, and only a later saying of `live` clears a mock. Read from the
 * verdicts the release record already holds for each live criterion, oldest first, those a reopen
 * voided before those it kept (`release-facts.ts:carriedVerdictsOf`); a close's verdict says none.
 */
export function lineProofsOf(weighed: readonly WeighedIssue[]): Map<string, IntegrationProof> {
  const out = new Map<string, IntegrationProof>();
  for (const { issue } of weighed) {
    const said: IntegrationProof[] = [];
    for (const n of new Set([...issue.voided.keys(), ...issue.verdicts.keys()])) {
      const newestFirst = [
        ...(issue.voided.get(n) ?? []),
        ...(issue.verdicts.get(n) ?? []),
      ].reverse();
      const newest = newestFirst.find((v) => v.integrationProof != null)?.integrationProof;
      if (newest) said.push(newest);
    }
    if (said.length > 0) out.set(issue.id, said.includes('simulated') ? 'simulated' : 'live');
  }
  return out;
}

/** Each line with its issue's outside-call proof, null where no judge said one. */
export function withProofs<T extends Changes>(record: ReleaseRecord, changes: T): T {
  const idOf = new Map(record.detail.issues.map((i) => [i.key, i.id] as const));
  const proofs = lineProofsOf(record.weighed);
  const on = (c: Change): Change => {
    const id = idOf.get(c.issueKey);
    return { ...c, proof: (id && proofs.get(id)) || null };
  };
  return { ...changes, improvements: changes.improvements.map(on), fixes: changes.fixes.map(on) };
}

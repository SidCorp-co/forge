// A revision_diff is held to the accept's own criteria rules where it is proposed (REQ-30 BC-3), and
// a drafted revision to the accept's own picture rules (REQ-35 BC-10).

import { SUGGESTION_PAYLOADS, type SuggestionProducer } from '@forge/contracts/suggestions';
import type { Tx } from '../db/client.js';
import type { Refusal } from '../lib/refusal.js';
import {
  criteriaRefusalsAt,
  draftPictureRefusals,
  landingIn,
  NEW_REQUIREMENT,
  openRevisionOf,
  type RevisionWrite,
} from '../requirements/index.js';
import type { SuggestionTarget } from './read.js';

/**
 * What the accept of this revision_diff would refuse in its criteria list, said at its proposal:
 * a code that is not live on its base, a code twice, an unparseable scenario. Its paths point into
 * the suggestion's payload. forge-dev 2026-10-08: REQ-32's BC-15 and REQ-33's BC-7, codes the BA
 * assistant gave new criteria, were created and refused only at a person's Accept.
 */
export async function revisionDiffRefusalsIn(
  tx: Tx,
  requirementId: string,
  baseRevision: number | null,
  payload: unknown,
): Promise<Refusal[]> {
  const { criteria } = SUGGESTION_PAYLOADS.revision_diff.schema.parse(payload) as RevisionWrite;
  const wrong = await criteriaRefusalsAt(tx, requirementId, baseRevision, criteria);
  return wrong.map((r) => ({ ...r, path: `/payload${r.path}` }));
}

/**
 * What a drafted revision's picture would be refused for where its accept lands it, said at its
 * proposal: on the open revision it rewrites (a base naming that revision, as `effects.ts`
 * lands it), else on a new revision carrying the head's, or on a new requirement. The BA
 * assistant's draft must also leave the revision showing a picture (REQ-35 BC-10); a person's or an
 * agent's suggestion need not (BC-14).
 */
export async function draftPictureRefusalsIn(
  tx: Tx,
  p: {
    kind: 'revision_diff' | 'requirement_draft';
    target: SuggestionTarget;
    baseRevision: number | null;
    payload: unknown;
    producerKind: SuggestionProducer;
  },
  head: number | null,
): Promise<Refusal[]> {
  const write = SUGGESTION_PAYLOADS[p.kind].schema.parse(p.payload);
  let landing = NEW_REQUIREMENT;
  if (p.kind === 'revision_diff') {
    const open = await openRevisionOf(tx, p.target.id);
    landing = await landingIn(
      tx,
      p.target.id,
      open && open.revision === p.baseRevision ? { revision: open.revision } : { head },
    );
  }
  const wrong = draftPictureRefusals(landing, write, p.producerKind === 'ba_assistant');
  return wrong.map((r) => ({ ...r, path: `/payload${r.path}` }));
}

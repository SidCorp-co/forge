// A revision_diff is held to the accept's own criteria rules where it is proposed (REQ-30 BC-3).

import { SUGGESTION_PAYLOADS } from '@forge/contracts/suggestions';
import type { Tx } from '../db/client.js';
import type { Refusal } from '../lib/refusal.js';
import { criteriaRefusalsAt, type RevisionWrite } from '../requirements/index.js';

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

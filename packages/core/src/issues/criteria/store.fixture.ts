// Test double for `store.ts:listCriteria`: the rows an issue would hold had its criteria text and
// its verdict comments been written through the store, so a reader's tests can stay in fence text.
// The identities are taken as written (an abbreviated commit included): the store's own refusals
// are `verdict-input.test.ts`'s subject, not a reader's.

import { parseForgeRecord } from '../../messaging/forge-record.js';
import { criterionBlocksIn } from '../../messaging/verdict-identity.js';
import { parseCriteriaText } from './criteria-text.js';
import type { CriterionWithVerdict, LatestVerdict } from './store.js';
import { identityFromBlock } from './verdict-input.js';

export function criteriaOfText(
  text: string | null,
  bodies: readonly string[],
): CriterionWithVerdict[] {
  const latest = new Map<number, LatestVerdict>();
  let at = 0;
  for (const body of bodies) {
    for (const block of criterionBlocksIn(parseForgeRecord(body))) {
      if (block.verdict === null) continue;
      const identity = identityFromBlock(block);
      at += 1;
      latest.set(block.criterion, {
        id: `v${at}`,
        verdict: block.verdict as LatestVerdict['verdict'],
        reason: block.why,
        identityKind: identity?.kind ?? null,
        commitSha: identity?.kind === 'commit' ? identity.sha : null,
        runtimeRef: identity?.kind === 'runtime' ? identity.ref : null,
        designWorkflowId: null,
        designFlow: identity?.kind === 'design' ? identity.workflow : null,
        designRevision: identity?.kind === 'design' ? identity.revision : null,
        contractRef: identity?.kind === 'contract' ? identity.ref : null,
        contractVersion: identity?.kind === 'contract' ? identity.version : null,
        storefrontWorkflowId: identity?.kind === 'storefront_draft' ? identity.workflowId : null,
        storefrontDraftVersion:
          identity?.kind === 'storefront_draft' ? identity.draftVersion : null,
        storefrontEnvironment: identity?.kind === 'storefront_draft' ? identity.environment : null,
        corroboration: null,
        corroborationNote: null,
        evidence: block.cited,
        authorAgency: 'agent',
        backfilled: false,
        createdAt: new Date(at * 1000).toISOString(),
      });
    }
  }
  return parseCriteriaText(text).criteria.map((c, position) => ({
    id: `c${c.n}`,
    n: c.n,
    statement: c.statement,
    position,
    requirementCriterionId: null,
    latest: latest.get(c.n) ?? null,
  }));
}

// A commit pass accepted on an owner's decision (REQ-36 BC-22, ISS-1223; catalog-api 0.6.0): the owner
// ruled that criteria no runtime verdict judged count as proven by the suite at a named commit, and
// recorded it as a `decision` on each issue. A pass naming that record stands accepted on every release
// carrying its issue (contracts `release-page.ts:countedOnRelease`), owes no live verdict, and is never
// proven (`verified-rule.ts:acceptedWhy`). Kernel input: one that cannot be placed is refused by name,
// and nothing is written.
//
//   rule                                                        code
//   only a pass is accepted                                     VERDICT_ACCEPTANCE_NOT_PASS
//   on a commit, the test run it names                          VERDICT_ACCEPTANCE_NOT_COMMIT
//   naming a standing `decision` record on this same issue      VERDICT_ACCEPTANCE_NOT_DECISION
//
// Whether the commit is placed on the issue's landing is asked as of any commit verdict
// (`verdict-landing.ts:offLandingFault`).

import type { Tx } from '../../db/client.js';
import { recordEventOn } from '../record-events/store.js';
import { withdrawalsOn } from '../record-events/withdrawn.js';
import type { VerdictDraft, VerdictRefusal } from './verdict-input.js';
import { verdictRefused } from './verdict-refused.js';

/** What a draft carrying `acceptedOn` must be before its decision is read; null where it is that. */
export function acceptanceShapeFault(
  draft: Pick<VerdictDraft, 'criterion' | 'verdict' | 'identity' | 'acceptedOn'>,
): VerdictRefusal | null {
  const { criterion, acceptedOn } = draft;
  if (!acceptedOn) return null;
  if (draft.verdict !== 'pass') {
    return {
      code: 'VERDICT_ACCEPTANCE_NOT_PASS',
      criterion,
      path: '/verdict',
      detail: `criterion ${criterion}'s \`${draft.verdict}\` names decision \`${acceptedOn}\` in \`acceptedOn\`, and only a pass is accepted on an owner's decision: send the fail, short or skip without \`acceptedOn\`. Nothing was written.`,
    };
  }
  if (draft.identity?.kind !== 'commit') {
    return {
      code: 'VERDICT_ACCEPTANCE_NOT_COMMIT',
      criterion,
      path: '/identity',
      detail: `criterion ${criterion}'s pass names decision \`${acceptedOn}\` in \`acceptedOn\` and is judged on ${draft.identity ? `a \`${draft.identity.kind}\`` : 'no identity'}: an accepted proof is a test run at a named commit, so it names \`{ kind: 'commit', sha }\`, the whole sha the run tested. A pass judged on the running build needs no acceptance. Nothing was written.`,
    };
  }
  return null;
}

/**
 * The decision an accepted pass names, as stored, once it is read as a standing `decision` record on
 * this issue: not another issue's, not another kind, not withdrawn. Refused by name otherwise.
 */
export async function acceptedOnOf(
  tx: Tx,
  issueId: string,
  draft: Pick<VerdictDraft, 'criterion' | 'acceptedOn'>,
): Promise<{ acceptedOn: string } | Record<string, never>> {
  const { criterion, acceptedOn } = draft;
  if (!acceptedOn) return {};
  const event = await recordEventOn(issueId, acceptedOn, tx);
  const withdrawn = event?.kind === 'decision' && (await withdrawalsOn(issueId, tx)).has(event.id);
  if (event?.kind === 'decision' && !withdrawn) return { acceptedOn: event.id };
  const found = !event
    ? 'which is no record on this issue (a record of another issue, or none)'
    : withdrawn
      ? 'a decision on this issue that was withdrawn, so it stands no more'
      : `a \`${event.kind}\` record on this issue, not a decision`;
  throw verdictRefused({
    code: 'VERDICT_ACCEPTANCE_NOT_DECISION',
    criterion,
    path: '/acceptedOn',
    detail: `criterion ${criterion}'s pass names \`${acceptedOn}\` in \`acceptedOn\`, ${found}. An accepted pass names the owner's standing \`decision\` record on this issue that accepts the proof (\`GET /api/issues/:id/events?kind=decision\` lists them by id). Nothing was written.`,
  });
}

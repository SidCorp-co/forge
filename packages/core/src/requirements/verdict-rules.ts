/**
 * What a verdict recorded on a business criterion at the requirement itself must carry (ISS-588), as
 * pure guards over what `verdicts.ts` read. Every rule a verdict on an issue criterion meets is met
 * here too (`issues/criteria/verdict-input.ts:verdictDraftFault`), and three more:
 *
 *   rule                                                        code
 *   the requirement is agreed, in delivery or delivered         REQUIREMENT_VERDICT_NOT_DELIVERING
 *   the criterion is a code with a wording live at the head     REQUIREMENT_VERDICT_CRITERION_UNKNOWN
 *   a pass, short or fail cites what it was taken from          REQUIREMENT_VERDICT_UNCITED
 */

import {
  isDeliveringStatus,
  type RecordRequirementVerdictRequest,
} from '@forge/contracts/requirements';
import { verdictDraftFault } from '../issues/index.js';
import type { RequirementRefusal } from './rules.js';

/** Where a shared verdict rule's refusal sits in this body, where the rule names no path itself. */
const SHARED_PATH: Record<string, string> = {
  VERDICT_VALUE_UNKNOWN: '/verdict',
  VERDICT_SKIP_REASON_REQUIRED: '/reason',
  VERDICT_IDENTITY_REQUIRED: '/identity',
  VERDICT_COMMIT_NOT_FULL: '/identity/sha',
};

/** The live criterion the verdict judges, or the refusals that stop it, in the order they are asked. */
export function requirementVerdictRefusals(input: {
  key: string;
  status: string;
  live: readonly { id: string; code: string }[];
  body: RecordRequirementVerdictRequest;
}): { criterion: { id: string; code: string } } | { refusals: RequirementRefusal[] } {
  const { key, status, live, body } = input;
  if (!isDeliveringStatus(status)) {
    return {
      refusals: [
        {
          code: 'REQUIREMENT_VERDICT_NOT_DELIVERING',
          path: '',
          detail: `${key} is ${status}; its criteria are judged on the running build only once it is agreed, in delivery or delivered.`,
        },
      ],
    };
  }
  const criterion = live.find((c) => c.code === body.criterion.toUpperCase());
  if (!criterion) {
    return {
      refusals: [
        {
          code: 'REQUIREMENT_VERDICT_CRITERION_UNKNOWN',
          path: '/criterion',
          detail: `${key} has no live criterion ${body.criterion}; name one of ${live.map((c) => c.code).join(', ') || 'none (it has no live criterion)'}.`,
        },
      ],
    };
  }
  const n = Number(criterion.code.slice(3));
  const evidence = body.evidence ?? [];
  const fault = verdictDraftFault({
    criterion: n,
    verdict: body.verdict,
    reason: body.reason ?? null,
    identity: body.identity ?? null,
    evidence,
  });
  if (fault) {
    return {
      refusals: [
        {
          code: fault.code as RequirementRefusal['code'],
          path: fault.path ?? SHARED_PATH[fault.code] ?? '',
          detail: fault.detail.replaceAll(`criterion ${n}`, criterion.code),
        },
      ],
    };
  }
  if (body.verdict !== 'skipped' && evidence.length === 0) {
    return {
      refusals: [
        {
          code: 'REQUIREMENT_VERDICT_UNCITED',
          path: '/evidence',
          detail: `${criterion.code}'s ${body.verdict} cites nothing: name what it was taken from, a link (a clip, a page) or a repository path at the commit judged.`,
        },
      ],
    };
  }
  return { criterion };
}

// The one rule every trace an issue criterion states is held to, whichever way it states it: a
// criterion proves a BC of its own issue's requirement. PUT /criteria took a `requirementCriterionId`
// of another requirement's BC that the lead tag `(REQ-n BC-m)` was refused for (FB-209), so both
// read this one check (`store.ts:tracedInputs`), and `POST /api/issues/:id/criteria/traces` takes
// bare `BC-n` codes resolved on that requirement alone (`tie.ts:appendTracedCriteria`).

import type { traceWordingsOf } from '../ports.js';

type TraceWordings = Awaited<ReturnType<typeof traceWordingsOf>>;

/** A trace as a criterion states it: by its lead tag, or by the id of the BC wording. */
export type StatedTrace =
  | { readonly requirementSeq: number; readonly code: string }
  | { readonly requirementCriterionId: string };

export const OWN_REQUIREMENT_RULE = "a criterion proves a BC of its own issue's requirement";

function namesOwn(stated: StatedTrace, { requirement, wordings }: TraceWordings): boolean {
  if ('requirementCriterionId' in stated) {
    return wordings.some((w) => w.id === stated.requirementCriterionId);
  }
  return requirement?.seq === stated.requirementSeq;
}

/**
 * Why criterion `n`'s trace is refused (CRITERIA_TRACE_UNRESOLVED): it names no BC of the
 * requirement its issue delivers, or the issue delivers none. Null where it names one of that
 * requirement's BCs. One sentence for the tag and the id, so they cannot be held to two rules.
 */
export function foreignTraceFault(
  n: number,
  stated: StatedTrace,
  own: TraceWordings,
): string | null {
  if (namesOwn(stated, own)) return null;
  const req = own.requirement;
  const named =
    'requirementCriterionId' in stated
      ? `is sent with requirementCriterionId ${stated.requirementCriterionId}`
      : `traces REQ-${stated.requirementSeq} ${stated.code}`;
  const serves = req ? `this issue serves REQ-${req.seq}` : 'this issue serves no requirement';
  const fix = req
    ? `open its line with (REQ-${req.seq} BC-<m>), or send the id of one of its BCs (GET /api/issues/:id/requirement lists them under \`revision.criteria\`), or null for none; another requirement's BC is proven by an issue linked to that requirement`
    : 'link it to the requirement it delivers first, or drop the trace';
  return `criterion ${n} ${named}, and ${serves}: ${OWN_REQUIREMENT_RULE}; ${fix}`;
}

// The release approval checklist as a release's record answers it (REQ-34 r2 BC-25; Requirement
// lifecycle r15 release_check): the requirements carried at their revisions, each carried
// criterion's latest verdict where the project asks for one, and the approver's own reason.

import { RELEASE_APPROVAL_CHECKLIST } from '@forge/contracts/checklist-registry';
import { checklistRefusals, evaluateChecklist } from '@forge/contracts/checklists';
import { describe, expect, it } from 'vitest';
import { type ApprovalFacts, approvalAnswersOf } from './approval-checklist.js';

const carried: ApprovalFacts['carried'] = [
  { issue: 'ISS-4', requirement: { key: 'REQ-2', revision: 3 } },
  { issue: 'ISS-5', requirement: null },
];

const judge = (f: ApprovalFacts, reason?: string) =>
  evaluateChecklist(RELEASE_APPROVAL_CHECKLIST, {
    given: reason === undefined ? {} : { reason },
    record: approvalAnswersOf(f),
  });

describe('the release approval checklist, read from what the release carries', () => {
  it('is complete when every carried criterion passes and the approver says why', () => {
    const e = judge({ carried, unpassed: [], verdictsRequired: true }, 'beta serves it cleanly');
    expect(e.complete).toBe(true);
    expect(e.answers.find((a) => a.question === 'carried')?.value).toBe(
      'REQ-2 at revision 3; ISS-5 serves no requirement.',
    );
  });

  it('names each criterion that is not a pass, and an approval with no reason', () => {
    const e = judge({
      carried,
      unpassed: [{ issue: 'ISS-4', n: 2, standing: 'fail' }],
      verdictsRequired: true,
    });
    const by = Object.fromEntries(checklistRefusals(e).map((r) => [r.question, r.detail]));
    expect(Object.keys(by)).toEqual(['verdicts', 'reason']);
    expect(by.verdicts).toContain('ISS-4 criterion 2 (fail)');
  });

  it('asks no verdict of a project that judges on the running build after release', () => {
    const e = judge(
      {
        carried,
        unpassed: [{ issue: 'ISS-4', n: 2, standing: 'not judged' }],
        verdictsRequired: false,
      },
      'judged live after release',
    );
    expect(e.complete).toBe(true);
  });

  it('refuses a release that carries no issue', () => {
    const e = judge({ carried: [], unpassed: [], verdictsRequired: true }, 'x');
    expect(checklistRefusals(e).map((r) => r.question)).toEqual(['carried']);
  });
});

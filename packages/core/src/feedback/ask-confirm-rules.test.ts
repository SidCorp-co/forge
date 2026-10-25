import { describe, expect, it } from 'vitest';
import { clarificationRefusal } from './rules.js';
import { reproductionRefusal } from './triage-checklist.js';
import { agentEvidenceRefusal } from './verb-rules.js';

// REQ-66 BC-4: one question at a time to a reporter, whichever of their items it is about
describe('a clarification is one at a time per reporter', () => {
  it('refuses while another of the reporter’s items holds an open question, naming it', () => {
    const refused = clarificationRefusal('new', null, { question: 'q-7', item: 'FB-12' });
    expect(refused).toMatchObject({ code: 'FEEDBACK_CLARIFICATION_ALREADY_OPEN' });
    expect(refused?.detail).toContain('q-7 on FB-12');
  });

  it('asks where nothing is open to the reporter', () => {
    expect(clarificationRefusal('new', null, null)).toBeNull();
    expect(clarificationRefusal('reopened', null)).toBeNull();
  });
});

// REQ-66 BC-8: an agent confirms or reopens with what it ran and saw; a person's own verify needs no note
describe('an agent settles a shipped fix with its evidence', () => {
  it('refuses an agent’s bare verify and reopen, on the field the REST door takes', () => {
    expect(agentEvidenceRefusal('agent', 'verified', undefined)).toMatchObject({
      code: 'FEEDBACK_EVIDENCE_REQUIRED',
      path: '/note',
    });
    expect(agentEvidenceRefusal('agent', 'reopened', '   ')).toMatchObject({ path: '/reason' });
  });

  it('takes an agent’s with evidence, and a person’s without', () => {
    expect(agentEvidenceRefusal('agent', 'verified', 'Ran the export: 3 rows of 3.')).toBeNull();
    expect(agentEvidenceRefusal('human', 'verified', undefined)).toBeNull();
  });
});

// REQ-66 BC-5: the triage records the attempt, never a bare yes or no
describe('a reproduction answer names its attempt', () => {
  it.each(['yes', 'no', 'Not reproduced.', 'I did not try', 'Nobody tried it yet.'])(
    'refuses "%s"',
    (bare) => {
      expect(reproductionRefusal({ reproduced: bare })).toMatchObject({
        code: 'FEEDBACK_REPRODUCTION_EMPTY',
        path: '/answers/reproduced',
      });
    },
  );

  it('takes what was tried and seen, and leaves a missing answer to the checklist', () => {
    expect(
      reproductionRefusal({ reproduced: 'Saved twice on dev.220, both cards gone.' }),
    ).toBeNull();
    expect(reproductionRefusal({ reproduced: 'curl /health →HTTP500' })).toBeNull();
    expect(reproductionRefusal({ reproduced: 'Reload clears it.' })).toBeNull();
    expect(reproductionRefusal({})).toBeNull();
    expect(reproductionRefusal(undefined)).toBeNull();
  });
});

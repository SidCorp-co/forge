import { describe, expect, it } from 'vitest';
import { clarificationRefusal } from './rules.js';
import { reproductionRefusal } from './triage-checklist.js';
import { agentEvidenceRefusal } from './verb-rules.js';

// REQ-66 r3 BC-4 (ISS-904): the agent asks the reporter the questions it needs; only a routed item
// is past asking
describe('a clarification is refused by the item’s phase, never by a count', () => {
  it('asks on an untriaged item, whatever is already open', () => {
    expect(clarificationRefusal('new')).toBeNull();
    expect(clarificationRefusal('reopened')).toBeNull();
  });

  it('refuses once the item is routed, naming why', () => {
    expect(clarificationRefusal('triaged')).toMatchObject({
      code: 'FEEDBACK_CLARIFICATION_CLOSED',
    });
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

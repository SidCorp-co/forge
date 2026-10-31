import { describe, expect, it } from 'vitest';
import { masterWork, owedLine, workDigest } from './owed.js';
import type { AgentConfirmOwed } from './ports.js';

// The owed lines for questions an agent owes and confirms an agent reporter owes (owed-confirms.ts).

const none: Parameters<typeof owedLine>[0] = {
  designs: [],
  revisions: [],
  breakdowns: [],
  triages: [],
  confirms: [],
  comments: [],
  documents: [],
  builderRuns: [],
  releaseNotes: [],
  warnedNotes: [],
  unnamedReleases: [],
  releaseMerges: [],
  releaseApprovals: [],
  answers: [],
  stewardAsks: [],
  questions: [],
  landedWork: [],
  marks: [],
  filings: [],
  recordings: [],
  requests: [],
  carriers: [],
  contentLanguage: 'en',
};

const dispatched = (owed: Parameters<typeof masterWork>[1]) => masterWork([], owed, 'dispatch');

// REQ-79 BC-14: outside strict a decision is owed by the master, and no person's Needs you lists
// it, so the pass names each open one with the doors that answer and void it
describe('questionsLine: the questions the master or a peer agent owes', () => {
  const owed = {
    ...none,
    questions: [
      { id: 'q1', on: 'ISS-4' },
      { id: 'q2', on: null },
    ],
  };

  it('names each with the issue it stands on, and the answer and void doors', () => {
    const line = owedLine(owed);
    expect(line).toContain(
      '2 questions are owed by you or a peer agent, not a person (q1 on ISS-4; q2)',
    );
    expect(line).toContain(
      'answer with your reason in `note` (`forge-runner api questions/<id>/answer -X POST`)',
    );
    expect(line).toContain('`forge-runner api questions/<id>/void -X POST`');
  });

  it('counts as owed work, so a pass is nudged for it and its digest moves', () => {
    expect(owedLine(none)).not.toContain('owed by you or a peer agent');
    expect(dispatched(owed).owed).toBe(2);
    expect(workDigest([], owed)).not.toBe(workDigest([], none));
  });
});

// REQ-66 BC-8: an agent reporter has no bell, so the master of the project it reported from confirms for it
describe('an agent reporter’s confirm on the owed line', () => {
  it('names an agent reporter’s owed confirm by its key and reporter, at the door of the project the item sits in', () => {
    const forge: AgentConfirmOwed = {
      key: 'FB-230',
      feedbackId: 'f230',
      reporter: 'catalog-fe',
      itemProjectId: 'home',
      home: true,
    };
    const own: AgentConfirmOwed = {
      ...forge,
      key: 'FB-4',
      feedbackId: 'f4',
      itemProjectId: 'p',
      home: false,
    };
    const one = owedLine({ ...none, confirms: [forge] });
    expect(one).toContain(
      '1 shipped feedback item an agent of this project reported owes its confirm (FB-230 from catalog-fe, `forge-runner api forge/feedback/FB-230/verify -X POST`)',
    );
    expect(one).toContain('evidence');
    expect(owedLine({ ...none, confirms: [forge, own] })).toContain(
      'owe their confirm (FB-230 from catalog-fe, `forge-runner api forge/feedback/FB-230/verify -X POST`; FB-4 from catalog-fe, `forge-runner api projects/p/feedback/FB-4/verify -X POST`)',
    );
  });
});

import { describe, expect, it } from 'vitest';
import { masterWork, owedLine, workDigest } from './owed.js';
import type { AgentConfirmOwed } from './ports.js';

// The owed lines for questions an agent owes, confirms an agent reporter owes (owed-confirms.ts), and
// the release holds whose act is the master's (ISS-888).
// @direct-test-of packages/core/src/masters/owed-confirms.ts
// @direct-test-of packages/core/src/masters/owed.ts
// @direct-test-of packages/core/src/masters/owed-release-gate.ts

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
  releaseHolds: [],
  requests: [],
  carriers: [],
  reviews: [],
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
      reportedFrom: 'p',
      waitEnded: null,
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
    expect(one).toContain('confirm it for that agent');
  });

  it('names an item again once its wait ended, saying how, and the wait door to set one (ISS-902)', () => {
    const base: AgentConfirmOwed = {
      key: 'FB-470',
      feedbackId: 'f470',
      reporter: 'agenfold-chat',
      itemProjectId: 'home',
      home: true,
      reportedFrom: 'p',
      waitEnded: 'lapsed',
    };
    const line = owedLine({
      ...none,
      confirms: [base, { ...base, key: 'FB-472', waitEnded: 'met' }],
    });
    expect(line).toContain(
      'FB-470 from agenfold-chat, its wait ended: its date passed, `forge-runner api forge/feedback/FB-470/verify -X POST`',
    );
    expect(line).toContain('FB-472 from agenfold-chat, its wait ended: the room message came');
    expect(owedLine({ ...none, confirms: [{ ...base, waitEnded: 'withdrawn' }] })).toContain(
      'FB-470 from agenfold-chat, its wait ended: the fix was reopened',
    );
    expect(line).toContain('`/confirm-wait`');
    expect(line).toContain('"reason":"<why it waits>"');
  });

  it('names the reporter, never a refused command, for an item in a project that is no door of the master’s (ISS-880)', () => {
    const elsewhere: AgentConfirmOwed = {
      key: 'FB-9',
      feedbackId: 'f9',
      reporter: 'catalog-fe',
      itemProjectId: 'q',
      home: false,
      reportedFrom: 'p',
      waitEnded: null,
    };
    const line = owedLine({ ...none, confirms: [elsewhere] });
    expect(line).toContain('FB-9 from catalog-fe, which only catalog-fe settles');
    expect(line).not.toContain('projects/q/feedback/FB-9/verify');
  });
});

// ISS-888: a hold that names the agent's act and is never read is how six landed issues waited at the
// release gate for days; the pass names every such hold with the command that settles it
describe('releaseHoldsLine: the release holds whose act is the master’s', () => {
  const shippedIn = {
    issueId: 'i879',
    key: 'ISS-879',
    code: 'RELEASE_SHIPPED_IN_OWED',
    waitingFor: "the issue's agent to record which release shipped it (0.4.0-dev.430)",
  };
  const criteria = {
    issueId: 'i12',
    key: 'ISS-12',
    code: 'RELEASE_CRITERIA_UNEARNED',
    waitingFor: 'a verdict on each criterion named at the running deployment',
  };
  const owed = { ...none, releaseHolds: [shippedIn, criteria] };

  it('names a shipped-in hold with the record that settles it', () => {
    const line = owedLine({ ...none, releaseHolds: [shippedIn] });
    expect(line).toContain(
      "1 issue waits at the release gate on the record of the release that shipped it, which you owe (ISS-879 i879: RELEASE_SHIPPED_IN_OWED, waiting for the issue's agent to record which release shipped it (0.4.0-dev.430))",
    );
    expect(line).toContain(
      `\`forge-runner api projects/<projectId>/shipped-in-records -X POST -d '{"issueId":"<id>","version":"<the shipped release holding it>","evidence":"<the git command and its answer>"}'\``,
    );
    expect(line).not.toContain('a hold whose act is yours');
  });

  it('names any other hold the agent owes, with the read that names its act', () => {
    const line = owedLine({ ...none, releaseHolds: [criteria] });
    expect(line).toContain(
      '1 issue waits at the release gate on a hold whose act is yours (ISS-12 i12: RELEASE_CRITERIA_UNEARNED',
    );
    expect(line).toContain('`forge-runner api issues/<id>`, its `releaseHold.reason`');
    expect(line).not.toContain('shipped-in-records');
  });

  it('counts as owed work, so a pass is nudged for it and its digest moves with the hold', () => {
    expect(owedLine(none)).not.toContain('release gate');
    expect(dispatched(owed).owed).toBe(2);
    expect(workDigest([], owed)).not.toBe(workDigest([], none));
    const recoded = {
      ...none,
      releaseHolds: [{ ...criteria, code: 'NO_RELEASE_GATE' }, shippedIn],
    };
    expect(workDigest([], recoded)).not.toBe(workDigest([], owed));
  });
});

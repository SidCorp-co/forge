// @direct-test-of packages/core/src/release-batch/approval-wake.ts
// ISS-914: a release approval's carry, read and resolved before anything is recorded: each wrong
// shape refused at its path, each entry resolved against what the release leaves unproven, and the
// run that asked told what was carried, each still owed.

import { describe, expect, it } from 'vitest';
import { RefusalError } from '../lib/refusal.js';
import { parseCarry, resolveCarry } from './approval-carry.js';
import { decisionMessage } from './approval-wake.js';

const pathOf = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    if (e instanceof RefusalError) return e.refusals.map((r) => `${r.code} ${r.path}`);
    throw e;
  }
  return [];
};

const facts = {
  unproven: [
    { issue: 'ISS-4', n: 2, standing: 'fail' },
    { issue: 'ISS-5', n: 1, standing: 'not judged' },
  ],
  criteria: [
    { issue: 'ISS-4', n: 1 },
    { issue: 'ISS-4', n: 2 },
    { issue: 'ISS-5', n: 1 },
  ],
};

describe('a carry is read by its shape', () => {
  it('takes all with a why, and a list naming each once', () => {
    expect(parseCarry({ all: true, why: ' flag off ' })).toEqual({ all: true, why: 'flag off' });
    expect(parseCarry([{ issue: 'ISS-4', n: 2, why: 'docs' }])).toEqual([
      { issue: 'ISS-4', n: 2, why: 'docs', at: 0 },
    ]);
  });

  it('refuses each wrong shape at its path', () => {
    expect(pathOf(() => parseCarry({ all: false, why: 'x' }))).toEqual([
      'RELEASE_APPROVAL_SHAPE /carry',
    ]);
    expect(pathOf(() => parseCarry({ all: true }))).toEqual(['RELEASE_APPROVAL_SHAPE /carry/why']);
    expect(pathOf(() => parseCarry({ all: true, why: 'x'.repeat(1001) }))).toEqual([
      'RELEASE_APPROVAL_SHAPE /carry/why',
    ]);
    expect(pathOf(() => parseCarry([]))).toEqual(['RELEASE_APPROVAL_SHAPE /carry']);
    expect(pathOf(() => parseCarry([{ issue: 'iss-4', n: 2, why: 'x' }]))).toEqual([
      'RELEASE_APPROVAL_SHAPE /carry/0/issue',
    ]);
    expect(pathOf(() => parseCarry([{ issue: 'ISS-4', n: 0, why: 'x' }]))).toEqual([
      'RELEASE_APPROVAL_SHAPE /carry/0/n',
    ]);
    expect(
      pathOf(() =>
        parseCarry([
          { issue: 'ISS-4', n: 2, why: 'x' },
          { issue: 'ISS-4', n: 2, why: 'y' },
        ]),
      ),
    ).toEqual(['RELEASE_APPROVAL_SHAPE /carry/1']);
  });
});

describe('a carry is resolved against what the release leaves unproven', () => {
  it('carries every unproven criterion for all, each with the why', () => {
    expect(resolveCarry({ all: true, why: 'w' }, facts)).toEqual({
      carried: [
        { issue: 'ISS-4', n: 2, standing: 'fail', why: 'w' },
        { issue: 'ISS-5', n: 1, standing: 'not judged', why: 'w' },
      ],
      refusals: [],
    });
  });

  it('refuses a proven criterion and an unknown one at their entries', () => {
    const r = resolveCarry(
      [
        { issue: 'ISS-4', n: 1, why: 'x', at: 0 },
        { issue: 'ISS-4', n: 9, why: 'x', at: 1 },
        { issue: 'ISS-77', n: 1, why: 'x', at: 2 },
      ],
      facts,
    );
    expect(r.refusals.map((x) => `${x.code} ${x.path}`)).toEqual([
      'RELEASE_CARRY_PROVEN /carry/0',
      'RELEASE_CARRY_UNKNOWN /carry/1',
      'RELEASE_CARRY_UNKNOWN /carry/2',
    ]);
  });
});

describe('the run that asked is told what the approval carried', () => {
  const decided = {
    projectId: 'p',
    runId: 'r',
    approvalId: 'a',
    decision: 'approved' as const,
    reason: 'ok',
    decidedBy: 'u',
    decidedAt: '2026-11-03T10:00:00.000Z',
  };

  it('names each carried criterion as still owed', () => {
    const said = decisionMessage(
      { ...decided, carried: [{ issue: 'ISS-4', n: 2, standing: 'fail', why: 'w' }] },
      'Lan',
    );
    expect(said).toContain('carried 1 unproven criterion');
    expect(said).toContain('ISS-4 #2');
    expect(said).toContain('stays owed after the release');
  });

  it('says nothing of a carry where none was made', () => {
    expect(decisionMessage({ ...decided, carried: [] }, 'Lan')).not.toContain('carried');
  });
});

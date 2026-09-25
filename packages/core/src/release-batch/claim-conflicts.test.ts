import { describe, expect, it } from 'vitest';
import { releaseBlockerSentence } from './blocker-sentences.js';
import {
  type ClaimConflict,
  claimConflictDetails,
  claimConflictSentence,
  readClaimConflictDetails,
} from './claim-conflicts.js';

const P = 'p-1';
const GATE = 'awaiting_release';

const held = (key: string, runId = 'run-ended'): ClaimConflict => ({
  id: `id-${key}`,
  key,
  standing: 'claimed',
  runId,
  runEnded: true,
  claimer: 'batch',
  status: 'releasing',
});
const running = (key: string, runId = 'run-open'): ClaimConflict => ({
  id: `id-${key}`,
  key,
  standing: 'claimed',
  runId,
  runEnded: false,
  claimer: 'batch',
  status: 'releasing',
});
const staleAt = (
  key: string,
  runId = 'run-ended',
  claimer: 'batch' | 'record' = 'batch',
): ClaimConflict => ({
  id: `id-${key}`,
  key,
  standing: 'claimed',
  runId,
  runEnded: true,
  claimer,
  status: 'awaiting_release',
});
const recording = (key: string, runId = 'run-rec'): ClaimConflict => ({
  id: `id-${key}`,
  key,
  standing: 'claimed',
  runId,
  runEnded: false,
  claimer: 'record',
  status: 'awaiting_release',
});
const at = (key: string, status: 'testing' | 'closed' | 'dropped'): ClaimConflict => ({
  id: `id-${key}`,
  key,
  standing: 'status',
  status,
});
const absent = (id: string): ClaimConflict => ({ id, key: id, standing: 'absent' });

describe('claimConflictSentence', () => {
  it('names a roster held by a batch that ended with the return-to-gate abort on that batch', () => {
    const s = claimConflictSentence(P, GATE, [held('ISS-11'), held('ISS-12')]);
    expect(s).toMatch(/^2 issues named here cannot be claimed for a release\./);
    expect(s).toContain(
      'ISS-11, ISS-12 are at `releasing`, still claimed by release batch run-ended',
    );
    expect(s).toContain(
      'POST /api/projects/p-1/release-batches/run-ended/abort and a body of {"promotedRoster":"return-to-gate"}',
    );
    expect(s).toContain('then send them again');
  });

  it('names a batch still running by its state path and offers no abort', () => {
    const s = claimConflictSentence(P, GATE, [running('ISS-3')]);
    expect(s).toContain('ISS-3 is claimed by release batch run-open, which is still running');
    expect(s).toContain('GET /api/projects/p-1/release-batches/run-open/state');
    expect(s).not.toMatch(/abort/i);
  });

  it('tells an issue at the gate that an ended run still claims the sweep clears it, not an abort', () => {
    const s = claimConflictSentence(P, GATE, [staleAt('ISS-7')]);
    expect(s).toContain(
      'ISS-7 is still claimed by release batch run-ended, which has ended: the pipeline sweep clears',
    );
    expect(s).toContain('send it again after it has run');
    expect(s).not.toMatch(/abort/i);
  });

  it('splits one ended batch into the abort for `releasing` and the sweep for the gate', () => {
    const s = claimConflictSentence(P, GATE, [held('ISS-8'), staleAt('ISS-9')]);
    expect(s).toContain('ISS-8 is at `releasing`, still claimed by release batch run-ended');
    expect(s).toContain('puts it back at the release gate, then send it again.');
    expect(s).toContain(
      'ISS-9 is still claimed by release batch run-ended, which has ended: the pipeline sweep',
    );
    expect(s).not.toMatch(/ISS-8, ISS-9|ISS-9, ISS-8/);
  });

  it('names a release record by its record path, never a batch path or an abort', () => {
    const s = claimConflictSentence(P, GATE, [recording('ISS-10')]);
    expect(s).toContain('ISS-10 is claimed by release record run-rec');
    expect(s).toContain('GET /api/projects/p-1/release-records/run-rec');
    expect(s).not.toContain('release-batches');
    expect(s).not.toContain('release batch');
    expect(s).not.toMatch(/abort/i);
  });

  it('names a release record that ended as a record, with the sweep', () => {
    const s = claimConflictSentence(P, GATE, [staleAt('ISS-12', 'run-rec', 'record')]);
    expect(s).toContain('ISS-12 is still claimed by release record run-rec, which has ended');
    expect(s).not.toContain('release batch');
    expect(s).not.toMatch(/abort/i);
  });

  it('groups statuses apart and names each against the gate', () => {
    const s = claimConflictSentence(P, GATE, [
      at('ISS-4', 'testing'),
      at('ISS-5', 'closed'),
      at('ISS-6', 'testing'),
    ]);
    expect(s).toContain('ISS-4, ISS-6 are at `testing`, not `awaiting_release`');
    expect(s).toContain('ISS-5 is at `closed`: already shipped');
  });

  it('tells an issue at closed it already shipped, and not to wait for the gate', () => {
    const one = claimConflictSentence(P, GATE, [at('ISS-5', 'closed')]);
    expect(one).toContain(
      'ISS-5 is at `closed`: already shipped, and a release carries an issue once. If one has to ship again, reopen it',
    );
    expect(one).not.toContain('only once it reaches the release gate');
    const two = claimConflictSentence(P, GATE, [at('ISS-5', 'closed'), at('ISS-7', 'closed')]);
    expect(two).toContain('ISS-5, ISS-7 are at `closed`: already shipped');
    expect(two).toContain('If any of them has to ship again');
  });

  it('tells an issue at dropped it was set down as not work, and not to wait for the gate', () => {
    const one = claimConflictSentence(P, GATE, [at('ISS-8', 'dropped')]);
    expect(one).toContain('ISS-8 is at `dropped`: set down as not work, so no release carries it.');
    expect(one).not.toContain('release gate');
    const two = claimConflictSentence(P, GATE, [at('ISS-8', 'dropped'), at('ISS-9', 'dropped')]);
    expect(two).toContain(
      'ISS-8, ISS-9 are at `dropped`: set down as not work, so no release carries them.',
    );
  });

  it('names an id that is no issue on the project as it was sent', () => {
    expect(claimConflictSentence(P, GATE, [absent('x-1')])).toContain(
      'x-1 is no issue on this project.',
    );
    expect(claimConflictSentence(P, GATE, [absent('x-1'), absent('x-2')])).toContain(
      'x-1, x-2 are no issues on this project.',
    );
  });

  it('gives each reason its own sentence, and a batch per claiming run', () => {
    const s = claimConflictSentence(P, GATE, [
      held('ISS-1', 'run-a'),
      running('ISS-2', 'run-b'),
      at('ISS-3', 'testing'),
      absent('x-9'),
    ]);
    expect(s).toMatch(/^4 issues named here/);
    expect(s).toContain('ISS-1 is at `releasing`, still claimed by release batch run-a');
    expect(s).toContain('ISS-2 is claimed by release batch run-b');
    expect(s).toContain('ISS-3 is at `testing`');
    expect(s).toContain('x-9 is no issue on this project.');
  });
});

describe('CLAIM_CONFLICT through the one sentence every door composes', () => {
  it('composes from the standings its details carry', () => {
    const details = claimConflictDetails(P, GATE, [held('ISS-11')]);
    expect(releaseBlockerSentence('CLAIM_CONFLICT', details)).toBe(
      claimConflictSentence(P, GATE, [held('ISS-11')]),
    );
  });

  it('keeps the generic sentence where no standings ride on the details', () => {
    expect(releaseBlockerSentence('CLAIM_CONFLICT', { issueIds: ['a', 'b'] })).toMatch(
      /^2 issue\(s\) named here are not at the release gate/,
    );
    expect(readClaimConflictDetails({ issueIds: ['a'], conflicts: [] })).toBeNull();
  });
});

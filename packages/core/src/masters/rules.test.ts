import { saidDisagreements } from '@forge/contracts/said';
import { describe, expect, it } from 'vitest';
import {
  passAlreadyOpenRefusal,
  passNotOpenRefusal,
  projectArchivedRefusal,
  sessionEndedRefusal,
  slotsOf,
  slotsUndeclaredRefusal,
} from './rules.js';

// epod 2026-10-06: masters/standing served slots {inUse: 3, max: 2} while the box ran no job pane:
// three in-pane builder runs the masters declared were counted against max_job_panes, which caps
// only the job panes the daemon opens for pool jobs.

describe('masters/standing slots: in use counts what max_job_panes caps', () => {
  const box = { name: 'sid-xeon-1', maxJobPanes: 2 };

  it('counts job panes in use and serves the declared runs beside them, never over the cap', () => {
    expect(slotsOf(box, { jobPanes: 0, runs: 3 })).toEqual({
      inUse: 0,
      max: 2,
      runs: 3,
      undeclared: null,
    });
  });

  it('counts every job pane the box holds', () => {
    expect(slotsOf(box, { jobPanes: 2, runs: 1 })).toMatchObject({ inUse: 2, max: 2, runs: 1 });
  });

  it('names the undeclared cap and still counts both', () => {
    const s = slotsOf({ name: 'box', maxJobPanes: null }, { jobPanes: 1, runs: 2 });
    expect(s).toMatchObject({ inUse: 1, max: null, runs: 2 });
    expect(s.undeclared?.code).toBe('MASTER_SLOTS_UNDECLARED');
  });
});

// a master refusal reaches a person on the overview's slots line and the agents screen: its English is
// the sentence it says, so a reader in another language reads the same refusal in their words
describe('master refusals say their detail as a registry sentence', () => {
  const open = {
    id: 'p1',
    verb: 'drive',
    startedAt: '2026-10-07T10:00:00.000Z',
    issueKey: 'ISS-1',
  } as never;
  const closed = { ...(open as object), endedAt: '2026-10-07T11:00:00.000Z' } as never;

  it('renders every detail from what it says, the runner-read `id <uuid>` included', () => {
    const all = [
      slotsUndeclaredRefusal({ maxJobPanes: undefined, agentVersion: null }),
      slotsUndeclaredRefusal({ maxJobPanes: undefined, agentVersion: '0.4.1' }),
      passAlreadyOpenRefusal(open),
      passNotOpenRefusal({ passId: 'p9', named: closed, open }),
      passNotOpenRefusal({ passId: 'p9', named: null, open: null }),
      sessionEndedRefusal('ended', true),
      projectArchivedRefusal(new Date('2026-10-28T10:15:15.000Z')),
      slotsOf({ name: 'box', maxJobPanes: null }, { jobPanes: 0, runs: 0 }).undeclared,
    ];
    expect(saidDisagreements(all)).toEqual([]);
    expect(passAlreadyOpenRefusal(open)?.detail).toContain(
      'the drive pass started 2026-10-07T10:00:00.000Z on ISS-1 open, id p1;',
    );
    expect(all[0]?.detail).toContain('(runner version unknown)');
  });
});

// dev Forge 2026-10-28: an archived project's master was placed and opened a pass 45s after the archive
describe('an archived project opens no master pass', () => {
  it('refuses by name, saying when it was archived and how to drive it again', () => {
    const r = projectArchivedRefusal(new Date('2026-10-28T10:15:15.000Z'));
    expect(r?.code).toBe('MASTER_PROJECT_ARCHIVED');
    expect(r?.detail).toContain('archived at 2026-10-28T10:15:15.000Z');
    expect(r?.detail).toContain('/unarchive');
  });

  it('refuses nothing for a project that is not archived', () => {
    expect(projectArchivedRefusal(null)).toBeNull();
  });
});

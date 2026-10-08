import { RUN_GROUP_METADATA_KEY } from '@forge/contracts/agent-sessions';
import { saidDisagreements } from '@forge/contracts/said';
import { describe, expect, it } from 'vitest';
import { groupOf } from './runs-lane.js';

// a run with no group says why as a registry sentence beside its English, so the run detail reads the
// same reason in the reader's language
describe('the group a run was opened over, and why where there is none', () => {
  it('says each lane with no group, and the run-session row whose group is not recoverable', () => {
    const none = [
      groupOf({ metadata: null }, 'job'),
      groupOf({ metadata: null }, 'master'),
      groupOf({ metadata: null }, 'system'),
      groupOf({ metadata: {} }, 'run_session'),
    ];
    expect(none.map((g) => g.source)).toEqual(['none', 'none', 'none', 'none']);
    expect(saidDisagreements(none)).toEqual([]);
    expect(none.map((g) => (g.source === 'none' ? g.says.detail.key : null))).toEqual([
      'runs.group.job',
      'runs.group.master',
      'runs.group.system',
      'runs.group.unrecoverable',
    ]);
  });

  it('reads the stamped group with no sentence to say', () => {
    expect(groupOf({ metadata: { [RUN_GROUP_METADATA_KEY]: ['ISS-1'] } }, 'run_session')).toEqual({
      source: 'run_group',
      issues: ['ISS-1'],
      detail: null,
    });
  });
});

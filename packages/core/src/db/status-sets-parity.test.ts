import * as CONTRACT from '@forge/contracts/status-sets';
import * as WORK from '@forge/contracts/work-state';
import { describe, expect, it } from 'vitest';
import {
  BLOCKER_SETTLED_STATUSES,
  BLOCKER_SHIPPED_STATUSES,
} from '../issues/dependency-effects.js';
import { REASON_REQUIRED_STATUSES } from '../issues/transition-reason.js';
import * as CORE_WORK from '../issues/work-state.js';
import { LIVE_JOB_STATUSES } from '../jobs/status-sets.js';
import { memoryReindexStates } from './schema-memory-chunks.js';
import { terminalAgentSessionStatuses } from './session-vocabulary.js';

/**
 * `@forge/contracts/status-sets` is the browser's copy of answers this package owns, and
 * web-v2 may not import a runtime value from core. This file is the whole of what keeps
 * the two identical: without it, dropping a member here leaves the browser answering the
 * same question with the old set and nothing anywhere goes red.
 */

const MIRRORS: Record<string, { core: readonly string[]; contract: readonly string[] }> = {
  LIVE_JOB_STATUSES: { core: LIVE_JOB_STATUSES, contract: CONTRACT.LIVE_JOB_STATUSES },
  BLOCKER_SETTLED_STATUSES: {
    core: BLOCKER_SETTLED_STATUSES,
    contract: CONTRACT.BLOCKER_SETTLED_STATUSES,
  },
  BLOCKER_SHIPPED_STATUSES: {
    core: BLOCKER_SHIPPED_STATUSES,
    contract: CONTRACT.BLOCKER_SHIPPED_STATUSES,
  },
  REASON_REQUIRED_ISSUE_STATUSES: {
    core: [...REASON_REQUIRED_STATUSES],
    contract: CONTRACT.REASON_REQUIRED_ISSUE_STATUSES,
  },
  TERMINAL_AGENT_SESSION_STATUSES: {
    core: terminalAgentSessionStatuses,
    contract: CONTRACT.TERMINAL_AGENT_SESSION_STATUSES,
  },
  MEMORY_REINDEX_STATES: {
    core: memoryReindexStates,
    contract: CONTRACT.MEMORY_REINDEX_STATES,
  },
};

describe('the core and contracts copies of one status answer', () => {
  for (const [name, { core, contract }] of Object.entries(MIRRORS)) {
    it(`${name} holds what core holds, member for member`, () => {
      expect([...contract]).toEqual([...core]);
    });
  }

  it('covers every tuple the contracts module exports, so a new mirror cannot land unbound', () => {
    const exported = Object.entries(CONTRACT)
      .filter(([, value]) => Array.isArray(value))
      .map(([name]) => name)
      .sort();
    expect(exported).toEqual(Object.keys(MIRRORS).sort());
  });
});

/**
 * `@forge/contracts/work-state` owns the states and the rule that files a status in one, and core
 * counts by its own copy. Every figure of work a screen publishes is counted here and drawn there,
 * so a drift between the two is two screens disagreeing about one project with nothing red.
 */
describe('the core and contracts copies of the work-state map', () => {
  it('lists the same states, in the same order', () => {
    expect([...CORE_WORK.WORK_STATES]).toEqual([...WORK.WORK_STATES]);
    expect([...CORE_WORK.OPEN_WORK_STATES]).toEqual([...WORK.OPEN_WORK_STATES]);
  });

  it('files every status in the same state, member for member', () => {
    expect({ ...CORE_WORK.STATUS_WORK_STATE }).toEqual({ ...WORK.STATUS_WORK_STATE });
  });

  it('reads an issue the same way with and without a question owed', () => {
    for (const status of Object.keys(WORK.STATUS_WORK_STATE)) {
      for (const owes of [false, true]) {
        expect([status, owes, CORE_WORK.workStateOf(status as never, owes)]).toEqual([
          status,
          owes,
          WORK.workStateOf(status as never, owes),
        ]);
      }
    }
  });
});

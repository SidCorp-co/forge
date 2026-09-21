import * as CONTRACT from '@forge/contracts/status-sets';
import { describe, expect, it } from 'vitest';
import { BLOCKER_SETTLED_STATUSES } from '../issues/dependency-effects.js';
import { NON_OPEN_STATUSES } from '../issues/status-sets.js';
import { REASON_REQUIRED_STATUSES } from '../issues/transition-reason.js';
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
  NON_OPEN_ISSUE_STATUSES: {
    core: NON_OPEN_STATUSES,
    contract: CONTRACT.NON_OPEN_ISSUE_STATUSES,
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

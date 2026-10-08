// Where a session answers is core's to say (REQ-30 BC-4, ISS-439 round 4): the round 3 judge's
// session cleared its own room marker with a PATCH and was then read as answering no room.

import { describe, expect, it } from 'vitest';
import { isRefusal } from '../lib/refusal.js';
import {
  assertCallerNamesNoCoreKey,
  assertCoreKeysKept,
  CORE_OWNED_SESSION_KEYS,
} from './core-owned-metadata.js';

const marker = { conversationId: 'c', windowId: 'w', asker: { userId: 'u', viaTokenId: null } };
const refusedFor = (run: () => void): string => {
  try {
    run();
  } catch (err) {
    if (isRefusal(err, 'SESSION_METADATA_CORE_OWNED')) return err.refusals[0]?.detail ?? '';
    throw err;
  }
  throw new Error('expected SESSION_METADATA_CORE_OWNED');
};

describe("core's session keys", () => {
  it('are the room and escalation markers and the schedule source', () => {
    expect([...CORE_OWNED_SESSION_KEYS].sort()).toEqual(
      ['conversationAgent', 'escalation', 'scheduleRunId', 'source'].sort(),
    );
  });

  it('refuses a PATCH that clears, rewrites or forges one, naming it', () => {
    expect(refusedFor(() => assertCoreKeysKept({ conversationAgent: marker }, {}))).toContain(
      'conversationAgent',
    );
    expect(
      refusedFor(() =>
        assertCoreKeysKept(
          { conversationAgent: marker },
          { conversationAgent: { ...marker, conversationId: 'other' } },
        ),
      ),
    ).toContain('conversationAgent');
    expect(refusedFor(() => assertCoreKeysKept({}, { source: 'schedule.run' }))).toContain(
      'source',
    );
    expect(refusedFor(() => assertCoreKeysKept({ conversationAgent: marker }, null))).toContain(
      'nothing was written',
    );
  });

  it('lets a PATCH through that carries them unchanged, or a session that has none', () => {
    expect(() =>
      assertCoreKeysKept({ conversationAgent: marker, a: 1 }, { conversationAgent: marker, a: 2 }),
    ).not.toThrow();
    expect(() => assertCoreKeysKept(null, { note: 'x' })).not.toThrow();
  });

  it('refuses a new session that names one, and lets the rest of its metadata through', () => {
    expect(refusedFor(() => assertCallerNamesNoCoreKey({ escalation: {} }))).toContain(
      'escalation',
    );
    expect(() => assertCallerNamesNoCoreKey({ note: 'x' })).not.toThrow();
    expect(() => assertCallerNamesNoCoreKey(null)).not.toThrow();
  });
});

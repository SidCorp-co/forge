import { DECISION_ACT_NAMES } from '@forge/contracts/needs-you-decisions';
import { OUTBOX_CONSUMERS } from '@forge/contracts/outbox-consumers';
import { describe, expect, it } from 'vitest';
import { SETTLED_BY } from './settle-events.js';

describe('each act a person settles from Needs you reaches the workspace Activity (ISS-1053)', () => {
  it('names an event for every decision act', () => {
    expect(Object.keys(SETTLED_BY).sort()).toEqual([...DECISION_ACT_NAMES].sort());
  });

  it.each(DECISION_ACT_NAMES.map((act) => [act, SETTLED_BY[act]] as const))(
    '%s writes %s, which the org-activity consumer reads',
    (_act, event) => {
      const consumers: readonly string[] = OUTBOX_CONSUMERS[event];
      expect(consumers).toContain('org-activity');
    },
  );
});

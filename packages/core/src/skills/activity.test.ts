import {
  SKILL_ACTIVITY_EVENT_TYPES,
  SKILL_ACTIVITY_OUTCOMES,
  SKILL_ACTIVITY_TRIGGERS,
} from '@forge/contracts';
import { describe, expect, it, vi } from 'vitest';
import {
  skillActivityEventTypes,
  skillActivityOutcomes,
  skillActivityTriggers,
} from '../db/schema.js';

describe('skill-activity contract parity', () => {
  it('event types match between db/schema.ts and @forge/contracts', () => {
    expect([...SKILL_ACTIVITY_EVENT_TYPES]).toEqual([...skillActivityEventTypes]);
  });

  it('triggers match between db/schema.ts and @forge/contracts', () => {
    expect([...SKILL_ACTIVITY_TRIGGERS]).toEqual([...skillActivityTriggers]);
  });

  it('outcomes match between db/schema.ts and @forge/contracts', () => {
    expect([...SKILL_ACTIVITY_OUTCOMES]).toEqual([...skillActivityOutcomes]);
  });
});

describe('recordSkillActivityEvent', () => {
  it('inserts via the given executor with defaults applied', async () => {
    const insertValues = vi.fn(async () => {});
    const insertFn = vi.fn(() => ({ values: insertValues }));
    const executor = { insert: insertFn } as never;

    const { recordSkillActivityEvent } = await import('./activity.js');
    await recordSkillActivityEvent(executor, {
      eventType: 'skill.body.changed',
      actor: 'agent:master',
      trigger: 'poll',
      projectId: 'p1',
      skillId: 's1',
      beforeHash: 'a1b2c3',
      afterHash: 'd4e5f6',
      deltaSummary: '+18/-4',
      reason: 'reconcile',
    });

    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'skill.body.changed',
        actor: 'agent:master',
        trigger: 'poll',
        projectId: 'p1',
        skillId: 's1',
        deviceId: null,
        beforeHash: 'a1b2c3',
        afterHash: 'd4e5f6',
        deltaSummary: '+18/-4',
        reason: 'reconcile',
        outcome: 'ok',
        packetId: null,
      }),
    );
  });
});

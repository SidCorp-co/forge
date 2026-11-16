// ISS-1251: the door use tally counts each logged call on its door by agent kind and refusal code,
// a REST twin's call on the door it folds into, the misses agents' own audits named on each door, and
// lists a door no call named with 0.

import { describe, expect, it } from 'vitest';
import { catalogOf } from '../mcp/door-catalog.js';
import { tallyDoors } from './door-use.js';

const catalog = catalogOf([
  {
    id: 'support.member',
    surface: 'mcp',
    summary: 'records who a member is',
    feature: 'forge_support',
    twins: ['POST /api/projects/:id/support/session/members'],
  },
  { id: 'support.rule', surface: 'mcp', summary: 'keeps a rule', feature: 'forge_support' },
  {
    id: 'POST /api/projects/:id/feedback',
    surface: 'rest',
    summary: null,
    feature: '/api/projects/:id/feedback',
  },
]);
const at = '2026-11-16T01:00:00.000Z';

describe('the door use tally', () => {
  it('counts calls by agent kind, refusals by code, a twin’s calls and the misses agents named', () => {
    const { doors, unmatched } = tallyDoors(
      catalog,
      [
        {
          tool: 'forge_support',
          action: 'member',
          agent: 'room:support',
          code: 'ok',
          calls: 3,
          last_at: at,
        },
        {
          tool: 'forge_support',
          action: 'member',
          agent: 'box',
          code: 'forbidden',
          calls: 1,
          last_at: at,
        },
        {
          tool: 'forge_support',
          action: 'member',
          agent: 'room:support',
          code: 'SUPPORT_MEMBER_CONFIRMED',
          calls: 2,
          last_at: at,
        },
        {
          tool: 'rest',
          action: 'POST /api/projects/0b6f1f5e-7a7e-4c43-9d56-0c5e9a3b2f11/support/session/members',
          agent: 'room:agent',
          code: 'ok',
          calls: 5,
          last_at: at,
        },
        {
          tool: 'rest',
          action: 'POST /api/projects/0b6f1f5e-7a7e-4c43-9d56-0c5e9a3b2f11/feedback',
          agent: 'box',
          code: 'ok',
          calls: 2,
          last_at: at,
        },
        { tool: 'forge_gone', action: 'x', agent: 'person', code: 'ok', calls: 1, last_at: at },
      ],
      [
        { door: 'support.member', agent: 'room:support', n: 2 },
        // a miss named by the twin's route counts on the door it folds into
        { door: 'POST /api/projects/:id/support/session/members', agent: 'room:agent', n: 1 },
        { door: 'support.gone', agent: 'room:support', n: 4 },
      ],
    );
    expect(doors[0]).toMatchObject({
      door: 'support.member',
      name: 'support.member',
      calls: 11,
      viaTwins: 5,
      refused: 3,
      refusedBy: { forbidden: 1, SUPPORT_MEMBER_CONFIRMED: 2 },
      misses: 3,
      missedBy: { 'room:support': 2, 'room:agent': 1 },
      byAgent: { 'room:support': 5, box: 1, 'room:agent': 5 },
      lastAt: at,
    });
    expect(doors.find((d) => d.door === 'POST /api/projects/:id/feedback')?.calls).toBe(2);
    expect(doors.find((d) => d.door === 'support.rule')).toMatchObject({
      calls: 0,
      refusedBy: {},
      misses: 0,
      card: null,
    });
    expect(unmatched).toEqual([{ door: 'forge_gone.x', calls: 1 }]);
  });
});

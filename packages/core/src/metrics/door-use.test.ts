// ISS-1251: the door use tally counts each logged call on its door by agent kind and code, adds a
// room act's recorded refusals by their code, and lists a door no call named with 0.

import { describe, expect, it } from 'vitest';
import { catalogOf } from '../mcp/door-catalog.js';
import { tallyDoors } from './door-use.js';

const catalog = catalogOf([
  {
    id: 'support.member',
    surface: 'mcp',
    summary: 'records who a member is',
    feature: 'forge_support',
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
  it('counts calls by agent kind and refusals by code, a room act’s recorded ones included', () => {
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
          tool: 'rest',
          action: 'POST /api/projects/0b6f1f5e-7a7e-4c43-9d56-0c5e9a3b2f11/feedback',
          agent: 'box',
          code: 'ok',
          calls: 2,
          last_at: at,
        },
        { tool: 'forge_gone', action: 'x', agent: 'person', code: 'ok', calls: 1, last_at: at },
      ],
      [{ act: 'member', code: 'SUPPORT_ACT_DENIED', n: 2 }],
    );
    expect(doors[0]).toMatchObject({
      door: 'support.member',
      calls: 4,
      refused: 3,
      refusedBy: { forbidden: 1, SUPPORT_ACT_DENIED: 2 },
      byAgent: { 'room:support': 3, box: 1 },
      lastAt: at,
    });
    expect(doors.find((d) => d.door === 'POST /api/projects/:id/feedback')?.calls).toBe(2);
    expect(doors.find((d) => d.door === 'support.rule')).toMatchObject({
      calls: 0,
      refusedBy: {},
      card: null,
    });
    expect(unmatched).toEqual([{ door: 'forge_gone.x', calls: 1 }]);
  });
});

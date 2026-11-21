// ISS-1251: the door use tally counts each logged call on its door by agent kind and refusal code,
// a REST twin's call on the door it folds into, the misses agents' own audits named on each door, and
// lists a door no call named with 0; a miss naming a door the catalog no longer serves is named in
// the read's limits, never dropped in silence, and one naming a route the app serves that no door
// counts (a REST read, ISS-1395) is named there as served.

import { describe, expect, it } from 'vitest';
import { catalogOf } from '../mcp/door-catalog.js';
import { DOOR_USE_LIMITS, doorUseLimits, tallyDoors } from './door-use.js';

const catalog = catalogOf(
  [
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
  ],
  ['GET /api/projects/:id/boxes', 'POST /api/projects/:id/feedback'],
);
const at = '2026-11-16T01:00:00.000Z';

describe('the door use tally', () => {
  it('counts calls by agent kind, refusals by code, a twin’s calls and the misses agents named', () => {
    const { doors, unmatched, unserved, routes } = tallyDoors(
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
        { door: 'support.gone', agent: 'session:master', n: 1 },
        // a REST read the app serves is no door here, and still served (ISS-1395)
        { door: 'GET /api/projects/:id/boxes', agent: 'session:master', n: 2 },
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
    expect(unserved).toEqual([{ door: 'support.gone', misses: 5 }]);
    expect(doorUseLimits(unserved).at(-1)).toBe(
      '5 misses named a door the catalog no longer serves, counted in no row and no total: support.gone (5).',
    );
    expect(routes).toEqual([{ door: 'GET /api/projects/:id/boxes', misses: 2 }]);
    expect(doorUseLimits(unserved, routes).slice(-2)).toEqual([
      '5 misses named a door the catalog no longer serves, counted in no row and no total: support.gone (5).',
      '2 misses named a route Forge serves that is no door here (a REST read), counted in no row and no total: GET /api/projects/:id/boxes (2).',
    ]);
    expect(doorUseLimits([])).toEqual(DOOR_USE_LIMITS);
  });
});

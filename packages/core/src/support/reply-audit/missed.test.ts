// ISS-1251 c3: a room agent's own audit names the capabilities its reply should have reached for and
// did not; each is kept under the door the catalog serves it as, a REST twin's route as the act it
// folds into, and a door Forge serves none as is refused by name, with nothing kept. Core infers no
// miss: the misses the capabilities page counts are only these.
//
// @direct-test-of packages/core/src/support/reply-audit/audit.ts

import { describe, expect, it } from 'vitest';
import { catalogOf } from '../../mcp/door-catalog.js';
import { missesOf } from './audit.js';

const catalog = catalogOf(
  [
    {
      id: 'support.member',
      surface: 'mcp',
      summary: null,
      feature: 'forge_support',
      twins: ['POST /api/projects/:id/support/session/members'],
    },
    { id: 'POST /api/projects/:id/feedback', surface: 'rest', summary: null, feature: 'x' },
  ],
  ['GET /api/projects/:id/boxes', 'POST /api/projects/:id/feedback'],
);

describe('what an audit says its reply missed', () => {
  it('keeps each miss under its door id, a twin route as its act, once per door', () => {
    expect(
      missesOf(
        [
          { door: 'support.member', why: 'the asker named their role' },
          { door: 'POST /api/projects/:id/support/session/members', why: 'twice over' },
          { door: 'POST /api/projects/:id/feedback', why: 'a defect was reported' },
          // a route the app serves with no door (a REST read) is kept as its route (ISS-1395)
          { door: 'GET /api/projects/{id}/boxes', why: 'should have read the boxes' },
        ],
        catalog,
      ),
    ).toEqual({
      ok: true,
      value: [
        { door: 'support.member', why: 'the asker named their role' },
        { door: 'POST /api/projects/:id/feedback', why: 'a defect was reported' },
        { door: 'GET /api/projects/:id/boxes', why: 'should have read the boxes' },
      ],
    });
    expect(missesOf(undefined, catalog)).toEqual({ ok: true, value: [] });
  });

  it('refuses a door Forge serves none as, by name and where, keeping nothing', () => {
    const out = missesOf(
      [
        { door: 'support.member', why: 'fine' },
        { door: 'support.telepathy', why: 'should have read minds' },
      ],
      catalog,
    );
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.refusals[0]).toMatchObject({
      code: 'SUPPORT_AUDIT_DOOR_UNKNOWN',
      path: '/missed/1/door',
    });
    expect(out.refusals[0]?.detail).toContain('support.telepathy');
  });
});

// ISS-1251 c4: a master's, run's or steward's audit of its own output is judged as a room agent's is:
// each failed line one of its role's rubric or a card's red flag it tripped, each door read against
// the catalog, and anything else refused by name at its path, with nothing kept. ISS-1395: a missed
// door naming a route the app serves that no door counts (a REST read) is kept as that route, never
// told it is no door Forge serves; a name that is neither a capability nor a served route still is.
//
// @direct-test-of packages/core/src/support/reply-audit/self-audit.ts

import { describe, expect, it } from 'vitest';
import { catalogOf, servedDoorCatalog } from '../../mcp/door-catalog.js';
import { judgeSelfAudit } from './self-audit.js';

const card = (id: string, redFlag?: string, owner = 'x') => ({
  id,
  owner,
  purpose: 'Does it.',
  situations: [{ when: 'you need it', do: 'call it' }],
  practice: ['Call it once.'],
  audience: ['run' as const],
  scenarios: [],
  ...(redFlag ? { redFlag } : {}),
});

const catalog = catalogOf(
  [
    {
      id: 'issues.transition',
      surface: 'mcp',
      summary: null,
      feature: 'forge_issues',
      card: card('issues.transition', 'Closing with a criterion unmet.'),
    },
    {
      id: 'issues.get',
      surface: 'mcp',
      summary: null,
      feature: 'forge_issues',
      card: card('issues.get'),
    },
    {
      id: 'POST /api/issues/:id/merge',
      surface: 'rest',
      summary: null,
      feature: 'issues',
      card: card('POST /api/issues/:id/merge', 'Marking merged before the gate ran.', 'issues'),
    },
  ],
  // every route the app serves, a REST read with no door among them (ISS-1395)
  ['GET /api/projects/:id/automation/fires/:fireId', 'POST /api/issues/:id/merge'],
);

describe("an agent's audit of its own output", () => {
  it('keeps a rubric line by its key and a tripped red flag by its door, each once', () => {
    expect(
      judgeSelfAudit(
        'run',
        [
          { line: 'in_scope', why: 'added a cleanup beside the fix' },
          { redFlag: 'issues.transition', why: 'closed with criterion 2 unmet' },
          { redFlag: 'issues.transition', why: 'twice' },
        ],
        [{ door: 'issues.get', why: 'never read the criteria first' }],
        catalog,
      ),
    ).toEqual({
      ok: true,
      value: {
        failed: [
          { line: 'in_scope', why: 'added a cleanup beside the fix' },
          { line: 'red_flag:issues.transition', why: 'closed with criterion 2 unmet' },
        ],
        missed: [{ door: 'issues.get', why: 'never read the criteria first' }],
      },
    });
  });

  it.each([
    [
      'a line of another role',
      'master' as const,
      [{ line: 'criteria_proven', why: 'a run line' }],
      'SELF_AUDIT_LINE_UNKNOWN',
      '/failed/0/line',
    ],
    [
      'an entry naming both a line and a red flag',
      'run' as const,
      [{ line: 'in_scope', redFlag: 'issues.transition', why: 'both' }],
      'SELF_AUDIT_LINE_UNKNOWN',
      '/failed/0',
    ],
    [
      'a red flag on a door Forge serves none as',
      'steward' as const,
      [{ redFlag: 'issues.telepathy', why: 'no such door' }],
      'SELF_AUDIT_DOOR_UNKNOWN',
      '/failed/0/redFlag',
    ],
    [
      'a red flag on a card that names none',
      'run' as const,
      [{ redFlag: 'issues.get', why: 'its card names no red flag' }],
      'SELF_AUDIT_NO_RED_FLAG',
      '/failed/0/redFlag',
    ],
  ])('refuses %s by name and where', (_, role, failed, code, path) => {
    const out = judgeSelfAudit(role, failed, undefined, catalog);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.refusals[0]).toMatchObject({ code, path });
  });

  it('reads a REST door by the capability name its Tier-0 map gives it, kept under its route', () => {
    // [MAP_NAME_REFUSED] before the fix: issues.merge was refused SELF_AUDIT_DOOR_UNKNOWN
    expect(
      judgeSelfAudit(
        'master',
        [{ redFlag: 'issues.merge', why: 'marked merged before the gate' }],
        [{ door: 'issues.merge', why: 'never marked it merged' }],
        catalog,
      ),
    ).toEqual({
      ok: true,
      value: {
        failed: [
          { line: 'red_flag:POST /api/issues/:id/merge', why: 'marked merged before the gate' },
        ],
        missed: [{ door: 'POST /api/issues/:id/merge', why: 'never marked it merged' }],
      },
    });
  });

  it.each([
    ['its template', 'GET /api/projects/:id/automation/fires/:fireId'],
    ['its contract template', 'GET /api/projects/{id}/automation/fires/{fireId}'],
    [
      'a path filled in',
      'GET /api/projects/0b6f1f5e-7a7e-4c43-9d56-0c5e9a3b2f11/automation/fires/f-9',
    ],
  ])('keeps a missed route the app serves with no door, named by %s, as its route', (_, door) => {
    // [SERVED_ROUTE_REFUSED] before the fix: it was refused SELF_AUDIT_DOOR_UNKNOWN, "no door Forge serves"
    expect(judgeSelfAudit('master', [], [{ door, why: 'read the fire first' }], catalog)).toEqual({
      ok: true,
      value: {
        failed: [],
        missed: [
          { door: 'GET /api/projects/:id/automation/fires/:fireId', why: 'read the fire first' },
        ],
      },
    });
  });

  it('keeps the two reads FB-805 named, against the routes this build serves', () => {
    const missed = [
      { door: 'GET /api/projects/:id/automation/fires/:fireId', why: 'read the fire first' },
      { door: 'GET /api/projects/:id/boxes', why: 'read the boxes first' },
    ];
    expect(judgeSelfAudit('master', [], missed, servedDoorCatalog())).toEqual({
      ok: true,
      value: { failed: [], missed },
    });
  });

  it('refuses a red flag on a served route with no card as naming none, never as no door', () => {
    const out = judgeSelfAudit(
      'master',
      [{ redFlag: 'GET /api/projects/:id/automation/fires/:fireId', why: 'x y z' }],
      undefined,
      catalog,
    );
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.refusals[0]).toMatchObject({
      code: 'SELF_AUDIT_NO_RED_FLAG',
      path: '/failed/0/redFlag',
    });
    expect(out.refusals[0]?.detail).not.toContain('no door Forge serves');
  });

  it.each([
    ['a capability', 'issues.mindread'],
    ['a route no method of it serves', 'DELETE /api/projects/:id/automation/fires/:fireId'],
    ['a path no route serves', 'GET /api/projects/:id/automation/telepathy'],
  ])('still refuses %s Forge serves none as, keeping nothing', (_, door) => {
    const out = judgeSelfAudit('master', [], [{ door, why: 'x y z' }], catalog);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.refusals[0]).toMatchObject({
      code: 'SELF_AUDIT_DOOR_UNKNOWN',
      path: '/missed/0/door',
    });
    expect(out.refusals[0]?.detail).toContain('no capability and no route by that name');
  });

  it('refuses a missed door Forge serves none as, under the self-audit code', () => {
    const out = judgeSelfAudit('master', [], [{ door: 'issues.mindread', why: 'x y z' }], catalog);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.refusals[0]).toMatchObject({
        code: 'SELF_AUDIT_DOOR_UNKNOWN',
        path: '/missed/0/door',
      });
      expect(out.refusals[0]?.detail).toContain('as your map or forge_find names it');
    }
  });
});

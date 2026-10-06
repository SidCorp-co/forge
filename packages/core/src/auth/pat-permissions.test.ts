import { describe, expect, it, vi } from 'vitest';

vi.mock('../config/env.js', () => ({
  env: { NODE_ENV: 'test', JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef' },
}));
vi.mock('../db/client.js', () => ({ db: {} }));

import { scopeForMethod } from '../middleware/pat-rest-surface.js';
import {
  PAT_ACCOUNT_ONLY_PERMISSIONS,
  PAT_EXCLUSION_DOORS,
  PAT_GRANT_EPOCH,
  PAT_PERMISSION_GROUPS,
  PAT_PERMISSION_LEVELS,
  PAT_PERMISSION_NAMES,
  PAT_PERMISSION_RESOURCES,
  PAT_UNGRANTABLE,
  type PatPermissionLevel,
  type PatPermissionResource,
  patGrantCovers,
  patPermissionPrefixes,
  patPermissionWanted,
  patPrefixForPath,
  patResourceForPath,
  patUngrantableFor,
} from './pat-permissions.js';

function prefixesOf(resource: string): string[] {
  return Object.keys(PAT_PERMISSION_RESOURCES[resource as PatPermissionResource].prefixes);
}

function prefixesAt(epoch: number): string[] {
  return Object.values(PAT_PERMISSION_RESOURCES)
    .flatMap((r) => Object.entries(r.prefixes as Record<string, number>))
    .filter(([, e]) => e === epoch)
    .map(([p]) => p)
    .sort();
}

const OFF_MENU = ['/api/pat', '/api/uploads', '/api/webhooks', '/api/nothing-mounted-here'];

function covers(
  granted: readonly string[] | null | undefined,
  path: string,
  level: PatPermissionLevel,
): boolean {
  return patGrantCovers(granted, patPermissionWanted(path, level));
}

const REACHABLE_ON_2026_09_10 = [
  '/api/attachments',
  '/api/comments',
  '/api/issue-step-contexts',
  '/api/issues',
  '/api/jobs',
  '/api/knowledge',
  '/api/knowledge-edges',
  '/api/labels',
  '/api/memory',
  '/api/pipeline-runs',
  '/api/projects',
  '/api/prompts',
  '/api/questions',
  '/api/schedules',
  '/api/skill-facts',
  '/api/skills',
  '/api/tasks',
];

/** ISS-1373 — what the menu grew by, written out so a prefix cannot join it quietly. */
const ADDED_AT_EPOCH_2 = [
  '/api/admin',
  '/api/agent-sessions',
  '/api/agents',
  '/api/app-config',
  '/api/auth/me',
  '/api/auth/preferences',
  '/api/body',
  '/api/chat-logs',
  '/api/conversations',
  '/api/devices',
  '/api/domain-templates',
  '/api/feedback-reports',
  '/api/improvement-messages',
  '/api/integration-connections',
  '/api/invitations',
  '/api/me',
  '/api/notifications',
  '/api/org-invitations',
  '/api/orgs',
  '/api/pipeline',
  '/api/runners',
  '/api/skill-activity',
  '/api/update-packets',
  '/api/usage-records',
];

describe('a token keeps the reach it was minted with', () => {
  it('holds epoch 1 to exactly the prefixes a PAT could reach before the menu grew', () => {
    expect(prefixesAt(1)).toEqual([...REACHABLE_ON_2026_09_10].sort());
  });

  it('puts every prefix added since at epoch 2', () => {
    expect(prefixesAt(2)).toEqual([...ADDED_AT_EPOCH_2].sort());
  });

  it('declares no epoch but those two, and mints at the highest', () => {
    expect(patPermissionPrefixes()).toEqual(
      [...REACHABLE_ON_2026_09_10, ...ADDED_AT_EPOCH_2].sort(),
    );
    expect(PAT_GRANT_EPOCH).toBe(2);
  });

  it('reports each prefix with the epoch it joined at', () => {
    expect(patPrefixForPath('/api/issues/abc')).toMatchObject({ prefix: '/api/issues', epoch: 1 });
    expect(patPrefixForPath('/api/body/abc')).toMatchObject({ prefix: '/api/body', epoch: 2 });
  });
});

describe('a resource says where it can be fenced', () => {
  it('declares every resource project or account', () => {
    for (const [resource, { reach }] of Object.entries(PAT_PERMISSION_RESOURCES)) {
      expect(['project', 'account'], resource).toContain(reach);
    }
  });

  it('names as account-only exactly the permissions of account resources', () => {
    const account = Object.entries(PAT_PERMISSION_RESOURCES)
      .filter(([, r]) => r.reach === 'account')
      .flatMap(([resource]) => PAT_PERMISSION_LEVELS.map((l) => `${resource}:${l}`))
      .sort();
    expect([...PAT_ACCOUNT_ONLY_PERMISSIONS]).toEqual(account);
    expect(account).toContain('orgs:write');
    expect(account).not.toContain('runners:read');
  });
});

describe('what is kept out of the grant grammar', () => {
  it('matches a :name segment against any one segment and a prefix beneath it', () => {
    expect(patUngrantableFor('/api/devices/me/pool', 'GET')?.pattern).toBe('/api/devices/me');
    expect(patUngrantableFor('/api/jobs/j1/ack', 'POST')?.pattern).toBe('POST /api/jobs/:id/ack');
  });

  it('keeps a method-led entry to that method', () => {
    expect(patUngrantableFor('/api/jobs/j1/ack', 'GET')).toBeNull();
    expect(patUngrantableFor('/api/jobs/j1/events', 'GET')).toBeNull();
  });

  it('wins over the menu prefix it sits inside, and leaves its siblings alone', () => {
    expect(patPrefixForPath('/api/devices/me/pool')?.resource).toBe('devices');
    expect(patUngrantableFor('/api/devices/d1/runners', 'GET')).toBeNull();
    expect(patUngrantableFor('/api/devices/login/approve', 'POST')).toBeNull();
  });

  it('never cancels a menu prefix whole', () => {
    for (const prefix of patPermissionPrefixes()) {
      for (const method of ['GET', 'POST']) {
        expect(patUngrantableFor(prefix, method), prefix).toBeNull();
      }
    }
  });

  it('carries a reason on every entry, naming the door its advice sends a caller to', () => {
    for (const [pattern, { admits, reason }] of Object.entries(PAT_UNGRANTABLE)) {
      expect(reason.trim(), pattern).not.toBe('');
      expect(reason, `${pattern} admits '${admits}', and its reason never says so`).toContain(
        PAT_EXCLUSION_DOORS[admits].names,
      );
    }
  });
});

describe('the resource declaration is a partition', () => {
  it('gives every resource at least one prefix', () => {
    for (const resource of Object.keys(PAT_PERMISSION_RESOURCES)) {
      expect(
        prefixesOf(resource),
        `${resource} covers no route — a permission nobody can use`,
      ).not.toHaveLength(0);
    }
  });

  it('claims no prefix from two resources', () => {
    const owners = new Map<string, string[]>();
    for (const resource of Object.keys(PAT_PERMISSION_RESOURCES)) {
      for (const prefix of prefixesOf(resource)) {
        owners.set(prefix, [...(owners.get(prefix) ?? []), resource]);
      }
    }
    const shared = [...owners].filter(([, r]) => r.length > 1);
    expect(
      shared,
      `these prefixes belong to more than one resource: ${JSON.stringify(shared)}`,
    ).toHaveLength(0);
  });
});

/**
 * The property the day-one claim rests on: a group's level is what
 * `scopeForMethod` answers, so the union over a resource's two levels is every
 * method on its prefixes. An enumerated verb list instead of a derived level
 * would break this for the first method nobody thought of, silently — the path
 * test is method-blind, so no existing test would notice.
 */
describe('the two levels class every method between them', () => {
  const METHODS = [
    'GET',
    'HEAD',
    'OPTIONS',
    'POST',
    'PUT',
    'PATCH',
    'DELETE',
    'TRACE',
    'CONNECT',
    'PROPFIND',
    'get',
    'patch',
  ];

  it.each(METHODS)('%s is classed by exactly one level', (method) => {
    const matched = PAT_PERMISSION_LEVELS.filter((level) => scopeForMethod(method) === level);
    expect(matched, `${method} matched ${matched.length} levels`).toHaveLength(1);
  });
});

describe('the menu is the cross of resources and levels', () => {
  it('names one permission per resource per level', () => {
    const resources = Object.keys(PAT_PERMISSION_RESOURCES).length;
    expect(PAT_PERMISSION_NAMES).toHaveLength(resources * PAT_PERMISSION_LEVELS.length);
  });

  it('gives a group the prefixes of its own resource', () => {
    for (const [name, group] of Object.entries(PAT_PERMISSION_GROUPS)) {
      expect(group.prefixes, name).toEqual(prefixesOf(group.resource));
      expect(group.reach, name).toBe(PAT_PERMISSION_RESOURCES[group.resource].reach);
      expect(name).toBe(`${group.resource}:${group.level}`);
    }
  });
});

/**
 * The inverse rule, for the prefixes whose absence is a decision rather than
 * an oversight: each belongs to no resource and is named out with its reason.
 */
describe('the prefixes that must belong to no permission', () => {
  it.each(['/api/uploads', '/api/pat', '/api/webhooks'])(
    '%s belongs to no resource and is kept out by name',
    (prefix) => {
      expect(patPermissionPrefixes()).not.toContain(prefix);
      const claiming = Object.keys(PAT_PERMISSION_RESOURCES).filter((r) =>
        prefixesOf(r).includes(prefix),
      );
      expect(claiming, `${prefix} is claimed by ${claiming.join(', ')}`).toHaveLength(0);
      expect(patUngrantableFor(prefix, 'GET')?.pattern).toBe(prefix);
    },
  );
});

/**
 * ISS-973 phase 2 — the menu's consumer.
 *
 * These are the menu-level properties: every name it declares is a name the
 * predicate honours, and every prefix it covers has exactly one resource to
 * answer for it. The request-level behaviour is
 * `middleware/pat-grant-fence.test.ts`.
 */
describe('the grant predicate honours the whole menu', () => {
  it.each([...PAT_PERMISSION_NAMES])('%s admits its own prefixes and no others', (name) => {
    const group = PAT_PERMISSION_GROUPS[name];
    for (const prefix of group.prefixes) {
      expect(covers([name], prefix, group.level), `${name} on ${prefix}`).toBe(true);
    }
    const foreign = patPermissionPrefixes().filter((p) => !group.prefixes.includes(p));
    for (const prefix of foreign) {
      expect(covers([name], prefix, group.level), `${name} leaked onto ${prefix}`).toBe(false);
    }
  });

  it.each([...PAT_PERMISSION_NAMES])('%s does not admit the other level', (name) => {
    const group = PAT_PERMISSION_GROUPS[name];
    const other = PAT_PERMISSION_LEVELS.find((l) => l !== group.level);
    expect(other, 'the menu has exactly two levels').toBeDefined();
    for (const prefix of group.prefixes) {
      expect(covers([name], prefix, other as typeof group.level)).toBe(false);
    }
  });
});

describe('an absent grant is every group, in each of its three shapes', () => {
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['an empty array', []],
  ] as const)('%s covers every prefix on the menu', (_label, granted) => {
    for (const prefix of patPermissionPrefixes()) {
      for (const level of PAT_PERMISSION_LEVELS) {
        expect(covers(granted, prefix, level), `${prefix} ${level}`).toBe(true);
      }
    }
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['an empty array', []],
  ] as const)('%s still covers nothing off the menu', (_label, granted) => {
    for (const prefix of OFF_MENU) {
      expect(covers(granted, prefix, 'read'), prefix).toBe(false);
    }
  });
});

/**
 * ISS-1255 — the difference between a grant that says "everything" and one
 * that says nothing at all.
 *
 * The two legacy shapes above keep their power, and this is the value a
 * minter picks instead. It is held off the menu on purpose: were `*` a name
 * the menu declared, a grant naming permissions could be holding it already,
 * and reading it as full access would hand that token power it never had.
 */
describe('full access is a value, not an absence', () => {
  it('is not a name the menu declares', () => {
    expect(PAT_PERMISSION_NAMES).not.toContain('*');
    expect(patPermissionWanted('/api/issues', 'read')).not.toBe('*');
  });

  it('covers every prefix on the menu, at both levels', () => {
    for (const prefix of patPermissionPrefixes()) {
      for (const level of PAT_PERMISSION_LEVELS) {
        expect(covers(['*'], prefix, level), `${prefix} ${level}`).toBe(true);
      }
    }
  });

  it('covers nothing off the menu, which stays the surface refusal', () => {
    for (const prefix of OFF_MENU) {
      expect(covers(['*'], prefix, 'read'), prefix).toBe(false);
    }
  });

  it('answers for the whole menu wherever in the grant it sits, which is why the door refuses it beside a name', () => {
    expect(covers(['issues:read'], '/api/schedules', 'read')).toBe(false);
    expect(covers(['*', 'issues:read'], '/api/schedules', 'read')).toBe(true);
  });
});

describe('a non-empty grant naming nothing the menu declares reaches nothing', () => {
  it('is the opposite direction to an absent grant, and deliberately so', () => {
    for (const prefix of patPermissionPrefixes()) {
      expect(covers(['retired:read'], prefix, 'read'), prefix).toBe(false);
    }
  });
});

describe('the path a refusal names', () => {
  it('names one permission per covered prefix, at the level asked for', () => {
    for (const resource of Object.keys(PAT_PERMISSION_RESOURCES)) {
      for (const prefix of prefixesOf(resource)) {
        expect(patPermissionWanted(prefix, 'read')).toBe(`${resource}:read`);
        expect(patPermissionWanted(`${prefix}/deep/path`, 'write')).toBe(`${resource}:write`);
      }
    }
  });

  it('names nothing for a path off the menu, which is the surface refusal instead', () => {
    for (const prefix of OFF_MENU) {
      expect(patPermissionWanted(prefix, 'read'), prefix).toBeNull();
      expect(patResourceForPath(prefix), prefix).toBeNull();
    }
  });

  it('does not treat a prefix as covering a longer sibling name', () => {
    expect(patResourceForPath('/api/issues-archive')).toBeNull();
    expect(patResourceForPath('/api/issues')).toBe('issues');
    expect(patResourceForPath('/api/issues/abc')).toBe('issues');
  });
});

/**
 * The granularity the menu actually has, pinned so it is a decision rather
 * than a surprise. Measured live on forge-beta at b32bdc2d while walking
 * ISS-973's criteria. The menu maps a resource to `/api/...` mount prefixes and
 * `patResourceForPath` answers with the resource owning the matched prefix, so
 * attribution is mount-shaped rather than subject-shaped: `projects:read` covers
 * every project-scoped sub-route that no narrower prefix claims first.
 */
describe('a permission is as coarse as its mount', () => {
  it('attributes a project-scoped sub-route to projects, not to its subject', () => {
    expect(patResourceForPath('/api/projects/p1/issues')).toBe('projects');
    expect(patResourceForPath('/api/projects/p1/schedules')).toBe('projects');
    expect(patResourceForPath('/api/projects/p1/knowledge')).toBe('projects');
  });

  it('so issues:read does not reach the project-scoped issue list, and projects:read does', () => {
    expect(covers(['issues:read'], '/api/projects/p1/issues', 'read')).toBe(false);
    expect(covers(['projects:read'], '/api/projects/p1/issues', 'read')).toBe(true);
  });

  it('and issues:read still reaches the flat mounts it names', () => {
    for (const prefix of prefixesOf('issues')) {
      expect(covers(['issues:read'], prefix, 'read'), prefix).toBe(true);
    }
  });
});

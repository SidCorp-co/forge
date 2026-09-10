/**
 * ISS-972 phase 1 — the permission menu replaced a hand-kept prefix array, and
 * the whole claim of that phase is that it changed no reachability. A claim
 * like that is worth exactly as much as the assertion holding it, so the 16
 * prefixes a PAT could reach before the change are frozen here as a literal.
 *
 * The literal is deliberately a second copy. Derived from the same declaration
 * it checks, it would agree with any edit — including the one that quietly adds
 * a prefix — and a test that cannot fail has not been written yet.
 */

import { describe, expect, it, vi } from 'vitest';

// cm:guard `scopeForMethod` is imported from the middleware that owns it rather than restated, and that module's import chain reaches `db/client.ts`. Mock the environment, never copy the method classification into this file — a second copy would agree with itself while the real one drifted, which is the failure this whole test file exists to prevent.
vi.mock('../config/env.js', () => ({
  env: { NODE_ENV: 'test', JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef' },
}));
vi.mock('../db/client.js', () => ({ db: {} }));

import { scopeForMethod } from '../middleware/pat-rest-surface.js';
import {
  PAT_PERMISSION_GROUPS,
  PAT_PERMISSION_LEVELS,
  PAT_PERMISSION_NAMES,
  PAT_PERMISSION_RESOURCES,
  patGrantCovers,
  patPermissionPrefixes,
  patPermissionWanted,
  patResourceForPath,
} from './pat-permissions.js';

// cm:guard the reachable set as it stood at 896ca541a, before the menu existed. Editing this list is how a reachability change is DECLARED — never how a red test is quieted. A prefix added to `PAT_PERMISSION_RESOURCES` and mirrored here in the same commit is a decision someone made; one mirrored here to make this test green again is the silent widening this exists to stop.
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
  '/api/schedules',
  '/api/skill-facts',
  '/api/skills',
  '/api/tasks',
];

describe('the menu changes no reachability', () => {
  it('covers exactly the prefixes a PAT could reach before it existed', () => {
    expect(patPermissionPrefixes()).toEqual([...REACHABLE_ON_2026_09_10].sort());
  });

  it('reaches every one of those prefixes through some named permission', () => {
    const viaGroups = new Set(Object.values(PAT_PERMISSION_GROUPS).flatMap((g) => g.prefixes));
    expect([...viaGroups].sort()).toEqual([...REACHABLE_ON_2026_09_10].sort());
  });
});

describe('the resource declaration is a partition', () => {
  it('gives every resource at least one prefix', () => {
    for (const [resource, prefixes] of Object.entries(PAT_PERMISSION_RESOURCES)) {
      expect(
        prefixes,
        `${resource} covers no route — a permission nobody can use`,
      ).not.toHaveLength(0);
    }
  });

  it('claims no prefix from two resources', () => {
    const owners = new Map<string, string[]>();
    for (const [resource, prefixes] of Object.entries(PAT_PERMISSION_RESOURCES)) {
      for (const prefix of prefixes) owners.set(prefix, [...(owners.get(prefix) ?? []), resource]);
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
      expect(group.prefixes, name).toEqual(PAT_PERMISSION_RESOURCES[group.resource]);
      expect(name).toBe(`${group.resource}:${group.level}`);
    }
  });
});

/**
 * The inverse rule. `middleware/pat-allowlist-reachable.test.ts` asserts these
 * four against the derived union; this asserts them against the declaration,
 * which is where someone would now add one.
 */
describe('the prefixes that must belong to no permission', () => {
  it.each(['/api/agent-sessions', '/api/uploads', '/api/admin', '/api/pat'])(
    '%s belongs to no resource',
    (prefix) => {
      expect(patPermissionPrefixes()).not.toContain(prefix);
      const claiming = Object.entries(PAT_PERMISSION_RESOURCES)
        .filter(([, prefixes]) => (prefixes as readonly string[]).includes(prefix))
        .map(([resource]) => resource);
      expect(claiming, `${prefix} is claimed by ${claiming.join(', ')}`).toHaveLength(0);
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
      expect(patGrantCovers([name], prefix, group.level), `${name} on ${prefix}`).toBe(true);
    }
    const foreign = patPermissionPrefixes().filter((p) => !group.prefixes.includes(p));
    for (const prefix of foreign) {
      expect(patGrantCovers([name], prefix, group.level), `${name} leaked onto ${prefix}`).toBe(
        false,
      );
    }
  });

  it.each([...PAT_PERMISSION_NAMES])('%s does not admit the other level', (name) => {
    const group = PAT_PERMISSION_GROUPS[name];
    const other = PAT_PERMISSION_LEVELS.find((l) => l !== group.level);
    expect(other, 'the menu has exactly two levels').toBeDefined();
    for (const prefix of group.prefixes) {
      expect(patGrantCovers([name], prefix, other as typeof group.level)).toBe(false);
    }
  });
});

// cm:guard the three shapes are asserted APART rather than folded into one `?? []`, because they arrive by different routes — a column the migration never wrote, a caller who sent `[]`, a principal built without the field — and one misplaced `??` makes exactly one of them permissionless while the others keep working (ISS-973).
describe('an absent grant is every group, in each of its three shapes', () => {
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['an empty array', []],
  ] as const)('%s covers every prefix on the menu', (_label, granted) => {
    for (const prefix of patPermissionPrefixes()) {
      for (const level of PAT_PERMISSION_LEVELS) {
        expect(patGrantCovers(granted, prefix, level), `${prefix} ${level}`).toBe(true);
      }
    }
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['an empty array', []],
  ] as const)('%s still covers nothing off the menu', (_label, granted) => {
    for (const prefix of ['/api/pat', '/api/admin', '/api/uploads', '/api/agent-sessions']) {
      expect(patGrantCovers(granted, prefix, 'read'), prefix).toBe(false);
    }
  });
});

describe('a non-empty grant naming nothing the menu declares reaches nothing', () => {
  it('is the opposite direction to an absent grant, and deliberately so', () => {
    for (const prefix of patPermissionPrefixes()) {
      expect(patGrantCovers(['retired:read'], prefix, 'read'), prefix).toBe(false);
    }
  });
});

describe('the path a refusal names', () => {
  it('names one permission per covered prefix, at the level asked for', () => {
    for (const [resource, prefixes] of Object.entries(PAT_PERMISSION_RESOURCES)) {
      for (const prefix of prefixes) {
        expect(patPermissionWanted(prefix, 'read')).toBe(`${resource}:read`);
        expect(patPermissionWanted(`${prefix}/deep/path`, 'write')).toBe(`${resource}:write`);
      }
    }
  });

  it('names nothing for a path off the menu, which is the surface refusal instead', () => {
    for (const prefix of ['/api/pat', '/api/admin', '/api/uploads', '/api/agent-sessions']) {
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
 * ISS-973's criteria; the reasoning and the shape of a fix are in
 * `docs/proposals/pat-permission-granularity-is-mount-shaped.md`.
 */
describe('a permission is as coarse as its mount', () => {
  it('attributes a project-scoped sub-route to projects, not to its subject', () => {
    expect(patResourceForPath('/api/projects/p1/issues')).toBe('projects');
    expect(patResourceForPath('/api/projects/p1/schedules')).toBe('projects');
    expect(patResourceForPath('/api/projects/p1/knowledge')).toBe('projects');
  });

  it('so issues:read does not reach the project-scoped issue list, and projects:read does', () => {
    expect(patGrantCovers(['issues:read'], '/api/projects/p1/issues', 'read')).toBe(false);
    expect(patGrantCovers(['projects:read'], '/api/projects/p1/issues', 'read')).toBe(true);
  });

  it('and issues:read still reaches the flat mounts it names', () => {
    for (const prefix of PAT_PERMISSION_RESOURCES.issues) {
      expect(patGrantCovers(['issues:read'], prefix, 'read'), prefix).toBe(true);
    }
  });
});

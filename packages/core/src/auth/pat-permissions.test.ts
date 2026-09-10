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
  patPermissionPrefixes,
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

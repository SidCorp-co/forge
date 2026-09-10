/**
 * The menu a personal access token's grants are chosen from.
 *
 * Two decisions kept apart. **What a permission means** is here: a named group
 * of REST route prefixes, declared in code so an operator picks from the menu
 * and cannot extend it — a route group an operator can invent is a fence
 * nobody proved. **Which permissions a token holds** is data on the token row,
 * and belongs to the phase that adds it; nothing in this module is consulted
 * by a request yet.
 *
 * `middleware/pat-rest-surface.ts` derives `PAT_ALLOWED_PREFIXES` from
 * {@link PAT_PERMISSION_RESOURCES}, so this declaration is the allowlist and
 * the prefix array is its union. `scripts/check-pat-surface.mjs` reads the same
 * declaration and proves every route under it reaches the project fence.
 */

import type { scopeForMethod } from '../middleware/pat-rest-surface.js';

/**
 * The one hand-kept list: a resource, and the `/api/...` mounts it covers.
 *
 * Prefixes are written once per RESOURCE rather than once per permission, so
 * the two levels of a resource cannot drift apart about what they cover.
 */
// cm:guard an ALLOWLIST, and it must stay one — a forgotten entry costs a caller a 403 they will report, while a forgotten entry on a deny-list is a silent leak nobody reports. Never invert this to "everything except", however much shorter that list looks: the routes that would need excluding are exactly the ones (`/api/pat`, `/api/orgs`, `/api/admin`, `/api/me`) where being wrong once ends the fence for good.
// cm:guard adding a prefix here WIDENS what every PAT may reach, because a token holding no grants reads as holding every group. A new entry owes the same proof the rest have: `scripts/check-pat-surface.mjs` must stay green, which means every route under it funnels through `effectiveProjectRole`.
// cm:edge lockstep -> packages/core/src/auth/pat-permissions.test.ts — the union of these prefixes is frozen there as a 16-entry literal. Editing this map without editing that literal is a deliberate reachability change presenting as a refactor, and the test is what makes the two indistinguishable impossible.
export const PAT_PERMISSION_RESOURCES = {
  issues: ['/api/issues', '/api/comments', '/api/attachments', '/api/labels'],
  tasks: ['/api/tasks'],
  pipeline: ['/api/pipeline-runs', '/api/jobs', '/api/issue-step-contexts'],
  knowledge: ['/api/knowledge', '/api/knowledge-edges', '/api/memory'],
  skills: ['/api/skills', '/api/skill-facts', '/api/prompts'],
  schedules: ['/api/schedules'],
  projects: ['/api/projects'],
} as const satisfies Record<string, readonly string[]>;

// cm:edge contract -> packages/core/src/agent-sessions/routes.ts — `/api/agent-sessions` belongs to NO resource above and must not be given one while its list route keeps a cross-project branch: `GET /api/agent-sessions` with no `projectId` returns every session of every project the caller can see, `messages[]` included. This list is now the ONLY thing keeping a PAT off it: the "inert because `requireUserOrDevice` has no PAT branch" reading held until ISS-932 gave that middleware one, and the branch resolves a device and sets no `userId` precisely so the fan-out stays out of reach. A PAT belongs on a project-scoped twin under `/api/projects/:id`, never on the fan-out.

// cm:edge contract -> packages/core/src/uploads/routes.ts — `/api/uploads` belongs to NO resource above and must not be given one: both its routes are mounted with no auth middleware at all (the ticket id IS the credential), so the entry would grant nothing today while pre-approving PAT reach the day someone bolts a gate on. It was listed until 2026-09-01 on the assumption that an allowlisted prefix is inert where no PAT branch runs; inert is exactly the problem — nobody would be making that decision when it stopped being inert.

export type PatPermissionResource = keyof typeof PAT_PERMISSION_RESOURCES;

/**
 * The two levels, taken from the scope test rather than restated.
 *
 * A level is what {@link scopeForMethod} answers for a method, so "which
 * methods are reads" keeps one home and a group's method predicate is
 * `scopeForMethod(method) === level`. An enumerated verb list here would
 * instead narrow reachability for every method outside it, silently: the path
 * test is method-blind today, so nothing would fail.
 */
// cm:guard these are the values `scopeForMethod` RETURNS, not a parallel enum — every method must be classed by exactly one of them or the union over a resource's two levels stops covering every method, which is the whole basis of the day-one claim. `admin` is deliberately absent: it is not a value the method test can answer.
export const PAT_PERMISSION_LEVELS = ['read', 'write'] as const satisfies readonly ReturnType<
  typeof scopeForMethod
>[];

export type PatPermissionLevel = (typeof PAT_PERMISSION_LEVELS)[number];

export type PatPermissionGroup = {
  readonly resource: PatPermissionResource;
  readonly level: PatPermissionLevel;
  readonly prefixes: readonly string[];
};

export type PatPermission = `${PatPermissionResource}:${PatPermissionLevel}`;

function buildGroups(): Readonly<Record<PatPermission, PatPermissionGroup>> {
  const out: Record<string, PatPermissionGroup> = {};
  for (const resource of Object.keys(PAT_PERMISSION_RESOURCES) as PatPermissionResource[]) {
    for (const level of PAT_PERMISSION_LEVELS) {
      out[`${resource}:${level}`] = Object.freeze({
        resource,
        level,
        prefixes: PAT_PERMISSION_RESOURCES[resource],
      });
    }
  }
  return Object.freeze(out) as Readonly<Record<PatPermission, PatPermissionGroup>>;
}

/** The menu: every resource crossed with every level. */
export const PAT_PERMISSION_GROUPS = buildGroups();

export const PAT_PERMISSION_NAMES = Object.freeze(
  Object.keys(PAT_PERMISSION_GROUPS).sort() as PatPermission[],
);

/** Every prefix any permission covers, sorted, deduplicated. */
export function patPermissionPrefixes(): readonly string[] {
  return Object.freeze([...new Set(Object.values(PAT_PERMISSION_RESOURCES).flat())].sort());
}

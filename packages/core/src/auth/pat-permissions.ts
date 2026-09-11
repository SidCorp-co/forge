/**
 * The menu a personal access token's grants are chosen from.
 *
 * Two decisions kept apart. **What a permission means** is here: a named group
 * of REST route prefixes, declared in code so an operator picks from the menu
 * and cannot extend it — a route group an operator can invent is a fence
 * nobody proved. **Which permissions a token holds** is data on the token row
 * (`personal_access_tokens.permissions`), read into the principal by
 * `middleware/require-pat.ts` and asked of this module on every request.
 *
 * `middleware/pat-rest-surface.ts` derives `PAT_ALLOWED_PREFIXES` from
 * {@link PAT_PERMISSION_RESOURCES}, so this declaration is the allowlist and
 * the prefix array is its union. `scripts/check-pat-surface.mjs` reads the same
 * declaration and proves every route under it reaches the project fence.
 *
 * Since ISS-973 the menu has a consumer: {@link patGrantCovers} answers a
 * request against the names one token was granted, and the union above is
 * what a token granted nothing still reaches.
 */

import type { scopeForMethod } from '../middleware/pat-rest-surface.js';

/**
 * The one hand-kept list: a resource, and the `/api/...` mounts it covers.
 *
 * Prefixes are written once per RESOURCE rather than once per permission, so
 * the two levels of a resource cannot drift apart about what they cover.
 */
// cm:guard an ALLOWLIST, and it must stay one — a forgotten entry costs a caller a 403 they will report, while a forgotten entry on a deny-list is a silent leak nobody reports. Never invert this to "everything except", however much shorter that list looks: the routes that would need excluding are exactly the ones (`/api/pat`, `/api/orgs`, `/api/admin`, `/api/me`) where being wrong once ends the fence for good.
// cm:guard adding a prefix here WIDENS what every PAT may reach, because an ABSENT or EMPTY grant array reads as holding every group (ISS-973) and 25 of production's 26 human tokens were minted before the column existed. A new entry owes the same proof the rest have: `scripts/check-pat-surface.mjs` must stay green, which means every route under it funnels through `effectiveProjectRole`.
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

// cm:edge contract -> packages/core/src/uploads/routes.ts — `/api/uploads` belongs to NO resource above and must not be given one: its two routes treat the ticket id AS the credential, so a PAT there would be a second credential on a surface designed to need none. Adding it would NOT be inert, and the older reasoning that said so was wrong — `uploadRoutes` declares no middleware of its own, but `guideRoutes`, `githubCallbackRoutes` and `deviceOwnerRoutes` are each mounted bare at `/api` with `use('*', requireAuth())`, and Hono runs the middleware of EVERY router whose mount prefix matches, so the fence already runs here. Measured on forge-beta at 46805dc0: a PAT on `GET /api/uploads` gets the fence's own `403 PAT_NOT_PERMITTED`. The prefix was listed until 2026-09-01 on the belief that it was inert; it never was.

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

function prefixMatches(prefix: string, path: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

// cm:guard attribution is MOUNT-shaped, not subject-shaped, and the first match wins over a longer one only because `check-pat-surface.mjs` refuses a prefix two resources claim. So `/api/projects/<id>/issues` resolves to `projects`, NOT `issues` — measured live on forge-beta at b32bdc2d — which makes `projects:read` a near-universal read grant and `issues:read` cover only the four flat mounts. Declared, not accidental: `docs/proposals/pat-permission-granularity-is-mount-shaped.md` carries the measurement and the shape a fix takes.
/** The resource whose prefixes cover this path, or null when the menu does not. */
export function patResourceForPath(path: string): PatPermissionResource | null {
  for (const resource of Object.keys(PAT_PERMISSION_RESOURCES) as PatPermissionResource[]) {
    if (PAT_PERMISSION_RESOURCES[resource].some((p) => prefixMatches(p, path))) return resource;
  }
  return null;
}

/**
 * The permission a request would have to hold, or null where no group covers
 * the path at all — which is the surface refusal, a different answer from
 * "covered, but not by this token".
 */
export function patPermissionWanted(path: string, level: PatPermissionLevel): PatPermission | null {
  const resource = patResourceForPath(path);
  return resource ? `${resource}:${level}` : null;
}

/**
 * Does a token granted `granted` hold the permission a request wanted?
 *
 * `wanted` is what {@link patPermissionWanted} answered, so `null` is "the menu
 * covers this path at all" answered no — a different refusal from "covered, but
 * not by this token".
 *
 * The grant is a narrowing, so its ABSENCE is the whole menu — and absence has
 * three shapes held to one answer: a `NULL` column the migration never wrote,
 * an empty array a caller sent, and a principal built without the field.
 */
// cm:guard absent AND empty both mean EVERY group, never no group. 26 active human tokens on production the day this shipped, 25 of them immortal, every one unmigrated the instant the column landed — reading an ungranted token as permissionless locks out every live integration on deploy (ISS-972's rule, ISS-973's implementation). The two shapes are one `?? []` away from being confused, so they are tested apart.
// cm:guard a NON-EMPTY array that names nothing this menu still declares covers NO path, which is the opposite direction to the rule above and is deliberate: a token somebody narrowed to `foo:read` after `foo` left the menu must reach nothing, never everything. Only absence is the full menu.
// cm:guard takes the DERIVED permission and never a path, so this predicate cannot resolve one: `beginPatRequest` calls `patPermissionWanted` once and hands that single value to the response header, to this check and to the refusal's `details.wanted`, which is what stops the three disagreeing. Give it a path again and the request path carries two resolutions that merely happen to agree — and every assertion about the header's value stays green while the property goes unproved (ISS-974).
export function patGrantCovers(
  granted: readonly string[] | null | undefined,
  wanted: PatPermission | null,
): boolean {
  if (wanted === null) return false;
  if (granted === null || granted === undefined || granted.length === 0) return true;
  return granted.includes(wanted);
}

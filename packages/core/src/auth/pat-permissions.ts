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
export const PAT_PERMISSION_RESOURCES = {
  issues: ['/api/issues', '/api/comments', '/api/attachments', '/api/labels'],
  tasks: ['/api/tasks'],
  pipeline: ['/api/pipeline-runs', '/api/jobs', '/api/issue-step-contexts'],
  knowledge: ['/api/knowledge', '/api/knowledge-edges', '/api/memory'],
  skills: ['/api/skills', '/api/skill-facts', '/api/prompts'],
  schedules: ['/api/schedules'],
  projects: ['/api/projects'],
  questions: ['/api/questions'],
} as const satisfies Record<string, readonly string[]>;

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
export function patGrantCovers(
  granted: readonly string[] | null | undefined,
  wanted: PatPermission | null,
): boolean {
  if (wanted === null) return false;
  if (granted === null || granted === undefined || granted.length === 0) return true;
  return granted.includes(wanted);
}

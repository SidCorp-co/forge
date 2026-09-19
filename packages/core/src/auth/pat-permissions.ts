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

export function patGrantCovers(
  granted: readonly string[] | null | undefined,
  wanted: PatPermission | null,
): boolean {
  if (wanted === null) return false;
  if (granted === null || granted === undefined || granted.length === 0) return true;
  return granted.includes(wanted);
}

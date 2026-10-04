import { TOKEN_EXPLICIT_PERMISSIONS } from '@forge/contracts/permissions';
import type { scopeForMethod } from '../middleware/pat-rest-surface.js';

/**
 * Where a resource's routes can be fenced. `project` routes resolve a project
 * and are proven fenced by `scripts/check-pat-surface.mjs`, so a project-scoped
 * token may hold them; `account` routes resolve none, so only a token carrying
 * its owner's whole reach may.
 */
type PatReach = 'project' | 'account';

type PatResourceDeclaration = {
  readonly reach: PatReach;
  /** Each prefix, and the grant epoch it joined the menu at. */
  readonly prefixes: Readonly<Record<string, number>>;
};

/**
 * The one hand-kept list: a resource, where it can be fenced, and the
 * `/api/...` mounts it covers.
 *
 * A prefix's epoch is what keeps granting from widening a token already
 * issued: a token reaches a prefix only when its own `grant_epoch` is at least
 * the prefix's, whatever it was granted. Epoch 1 is the menu as it stood before
 * any prefix was added to it; a prefix added later takes the next epoch.
 */
export const PAT_PERMISSION_RESOURCES = {
  issues: {
    reach: 'project',
    prefixes: {
      '/api/issues': 1,
      '/api/comments': 1,
      '/api/attachments': 1,
      '/api/labels': 1,
      '/api/body': 2,
    },
  },
  pipeline: {
    reach: 'project',
    prefixes: {
      '/api/pipeline-runs': 1,
      '/api/jobs': 1,
      '/api/issue-step-contexts': 1,
      '/api/agent-sessions': 2,
      '/api/pipeline': 2,
    },
  },
  knowledge: {
    reach: 'project',
    prefixes: { '/api/knowledge': 1, '/api/memory': 1 },
  },
  skills: {
    reach: 'project',
    prefixes: {
      '/api/skills': 1,
    },
  },
  schedules: { reach: 'project', prefixes: { '/api/schedules': 1 } },
  projects: {
    reach: 'project',
    prefixes: { '/api/projects': 1, '/api/app-config': 2 },
  },
  questions: { reach: 'project', prefixes: { '/api/questions': 1 } },
  runners: { reach: 'project', prefixes: { '/api/runners': 2 } },
  assistant: {
    reach: 'project',
    prefixes: { '/api/conversations': 2 },
  },
  // `feedback:read`/`feedback:write` keep meaning agent reports (ISS-59 decided): product feedback
  // FB-n mounts under `/api/projects/:id/feedback`, so `projects:*` grants it as it grants
  // requirements and suggestions. Repointing these grants at FB-n would hand every issued token a
  // reach its owner never chose, and renaming them would strip it in silence. cm:hack ISS-59
  // until:a migration rewrites the stored `feedback:*` grants to `agent-reports:*` — the grant word
  // `feedback` names agent reports, not FB-n, which a token-settings reader can misread. `/api/agent-reports` is `/api/feedback-reports` renamed — the same rows — so it
  // takes that prefix's epoch rather than the next.
  feedback: {
    reach: 'project',
    prefixes: {
      '/api/agent-reports': 2,
    },
  },
  account: {
    reach: 'account',
    prefixes: {
      '/api/auth/me': 2,
      '/api/auth/preferences': 2,
      '/api/me': 2,
      '/api/notifications': 2,
      '/api/invitations': 2,
      '/api/org-invitations': 2,
    },
  },
  orgs: { reach: 'account', prefixes: { '/api/orgs': 2, '/api/integration-connections': 2 } },
  ecosystems: { reach: 'account', prefixes: { '/api/ecosystems': 3, '/api/memberships': 3 } },
  devices: { reach: 'account', prefixes: { '/api/devices': 2 } },
  admin: { reach: 'account', prefixes: { '/api/admin': 2 } },
} as const satisfies Record<string, PatResourceDeclaration>;

// cm:why a route is dated by the data surface it serves, never by the mount it sits under (ISS-105,
// the orchestrator's decision): a route nested under an older mount that serves a newer prefix's rows
// takes that prefix's epoch, read off the prefix itself, and keeps its mount's grant word
export const PAT_NESTED_SURFACES = Object.freeze({
  '/api/projects/:id/agent-sessions': '/api/agent-sessions',
  '/api/projects/:id/run-sessions': '/api/agent-sessions',
  '/api/projects/:id/metrics/session-failures': '/api/agent-sessions',
  '/api/projects/:id/metrics/step-durations': '/api/pipeline',
  '/api/projects/:id/metrics/retry-rescues': '/api/pipeline',
  '/api/projects/:id/metrics/interventions': '/api/pipeline',
  '/api/projects/:id/analytics': '/api/pipeline',
  '/api/projects/:id/metrics/timeseries': '/api/pipeline',
  '/api/projects/:id/runners': '/api/runners',
  '/api/projects/:id/masters/standing': '/api/agent-sessions',
  '/api/projects/:id/masters/passes': '/api/agent-sessions',
  '/api/projects/:id/automation': '/api/agent-reports',
  '/api/issues/:id/cost-summary': '/api/pipeline',
} as const satisfies Record<string, PatPrefix>);

// cm:hack ISS-105 until:forge-plugin reads runner load at a route under /api/runners — GET
// /api/projects/:id/pm/runner-load serves /api/runners rows and is left out of PAT_NESTED_SURFACES, so
// it keeps its mount's epoch 1: forge-plugin 3.36.542 calls it (`tracker/routes.mjs`), and a token
// in the field older than epoch 2 would lose it. /mcp dates the same read at /api/runners already.

const PUBLIC = 'public: it reads no credential, so there is nothing for a grant to admit';
const SESSION =
  "the browser session's own lifecycle — signing up, signing in, refreshing, verifying, " +
  're-authenticating and signing out — which a token is not';
const DEVICE =
  "the paired box's own plane, admitted by the device credential minted at pairing or by a " +
  'pairing code; a personal or agent token is not a device';

const JOB =
  "a running job's own testing secrets, admitted by the job credential and decided by the job " +
  'it names; no grant reaches them, because a grant is not a job';

/**
 * Every path kept out of the grant grammar, and why. An entry is a path
 * prefix whose `:name` segments match any one segment, optionally led by one
 * method (`POST /api/...`) where only that method is kept out, and it wins
 * over a menu prefix it sits inside. Being here is not the same as refusing every
 * credential: a public route stays public and a device route keeps its device
 * credential. What it decides is the answer a personal or agent token gets.
 */
export const PAT_UNGRANTABLE: Readonly<Record<string, string>> = Object.freeze({
  '/health': PUBLIC,
  '/version': PUBLIC,
  '/api/health': PUBLIC,
  '/api/version': PUBLIC,
  '/install.sh': PUBLIC,
  '/install': PUBLIC,
  '/api/install.sh': PUBLIC,
  '/api/install': PUBLIC,
  '/guides': PUBLIC,
  '/llms.txt': PUBLIC,
  '/api/guides': PUBLIC,
  '/api/llms.txt': PUBLIC,
  '/pair': PUBLIC,
  '/api/pipeline/registry': PUBLIC,
  '/api/schemas': PUBLIC,
  '/api/workflow-templates': PUBLIC,
  '/orgs':
    'the guide router is mounted at the root for its public pages and its org-guide routes ride ' +
    'along there; the token path to them is /api/orgs',
  '/mcp':
    'the MCP transport, admitted by its own token door, where each tool declares the grant it needs and the transport reads it before the tool runs',
  '/api/auth/register': SESSION,
  '/api/auth/local': SESSION,
  '/api/auth/refresh': SESSION,
  '/api/auth/verify': SESSION,
  '/api/auth/dev': SESSION,
  '/api/auth/logout': SESSION,
  '/api/auth/reauth': SESSION,
  '/api/auth/oauth': SESSION,
  '/api/pat':
    'token management: a token that could mint, rotate or revoke tokens could widen its own grant',
  '/api/integrations/github':
    'a browser redirect GitHub sends back after an install, carrying the session that started it',
  '/api/uploads': 'ticket-authenticated: the single-use ticket in the path is the credential',
  '/api/webhooks': 'signed by the sender: the HMAC over the body is the credential',
  '/api/devices/me': DEVICE,
  '/api/devices/heartbeat': DEVICE,
  '/api/devices/pair': DEVICE,
  '/api/devices/login/init': DEVICE,
  '/api/devices/login/poll': DEVICE,
  'GET /api/jobs/:id/testing-profiles': JOB,
  'POST /api/jobs/:id/events': DEVICE,
  'POST /api/jobs/:id/ack': DEVICE,
  'POST /api/jobs/:id/complete': DEVICE,
  'POST /api/jobs/:id/fail': DEVICE,
  'POST /api/jobs/:id/kill-ack': DEVICE,
  'POST /api/agent-sessions/:id/ack': DEVICE,
  'POST /api/agent-sessions/:id/events': DEVICE,
  'POST /api/agent-sessions/:id/inbox/:seq/ack': DEVICE,
  'POST /api/agent-sessions/:id/inbox/:seq/applied': DEVICE,
});

type PatPermissionResource = keyof typeof PAT_PERMISSION_RESOURCES;

export const PAT_PERMISSION_LEVELS = ['read', 'write'] as const satisfies readonly ReturnType<
  typeof scopeForMethod
>[];

export type PatPermissionLevel = (typeof PAT_PERMISSION_LEVELS)[number];

type PatPermissionGroup = {
  readonly resource: PatPermissionResource;
  readonly level: PatPermissionLevel;
  readonly reach: PatReach;
  readonly prefixes: readonly string[];
};

export type PatPermission = `${PatPermissionResource}:${PatPermissionLevel}`;

const RESOURCES = Object.keys(PAT_PERMISSION_RESOURCES) as PatPermissionResource[];

function prefixesOf(resource: PatPermissionResource): readonly string[] {
  return Object.keys(PAT_PERMISSION_RESOURCES[resource].prefixes);
}

function buildGroups(): Readonly<Record<PatPermission, PatPermissionGroup>> {
  const out: Record<string, PatPermissionGroup> = {};
  for (const resource of RESOURCES) {
    for (const level of PAT_PERMISSION_LEVELS) {
      out[`${resource}:${level}`] = Object.freeze({
        resource,
        level,
        reach: PAT_PERMISSION_RESOURCES[resource].reach,
        prefixes: Object.freeze(prefixesOf(resource)),
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

/** The permissions only a token carrying its owner's whole reach may hold. */
export const PAT_ACCOUNT_ONLY_PERMISSIONS = Object.freeze(
  PAT_PERMISSION_NAMES.filter((name) => PAT_PERMISSION_GROUPS[name].reach === 'account'),
);

/** The epoch a token minted now is stamped with: the highest any prefix declares. */
export const PAT_GRANT_EPOCH: number = Math.max(
  ...RESOURCES.flatMap((r) => Object.values(PAT_PERMISSION_RESOURCES[r].prefixes)),
);

/** Every prefix any permission covers, sorted, deduplicated. */
export function patPermissionPrefixes(): readonly string[] {
  return Object.freeze([...new Set(RESOURCES.flatMap(prefixesOf))].sort());
}

function prefixMatches(prefix: string, path: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

type PatPrefixMatch = {
  readonly resource: PatPermissionResource;
  readonly prefix: string;
  readonly epoch: number;
  readonly reach: PatReach;
};

/** The menu prefix covering this path, with what it declares, or null. */
export function patPrefixForPath(path: string): PatPrefixMatch | null {
  for (const resource of RESOURCES) {
    const { reach, prefixes } = PAT_PERMISSION_RESOURCES[resource];
    for (const [prefix, epoch] of Object.entries(prefixes)) {
      if (prefixMatches(prefix, path)) return { resource, prefix, epoch, reach };
    }
  }
  return null;
}

type PatPrefix = {
  [R in PatPermissionResource]: keyof (typeof PAT_PERMISSION_RESOURCES)[R]['prefixes'] & string;
}[PatPermissionResource];

export type PatRoute = PatPrefix | keyof typeof PAT_NESTED_SURFACES;

export const PAT_GRANT_PREDATES_ROUTE = 'PAT_GRANT_PREDATES_ROUTE';

type PatEpochRefusal = {
  readonly resource: PatPermissionResource;
  readonly prefix: string;
  readonly surface: string | null;
  readonly routeEpoch: number;
  readonly tokenEpoch: number;
  readonly message: string;
};

type PatNestedSurface = {
  readonly route: string;
  readonly surface: PatPrefix;
  readonly epoch: number;
};

function patNestedSurfaceFor(path: string): PatNestedSurface | null {
  let found: PatNestedSurface | null = null;
  for (const [route, surface] of Object.entries(PAT_NESTED_SURFACES) as Array<
    [string, PatPrefix]
  >) {
    if (!patternMatches(route, path)) continue;
    if (found && found.route.split('/').length >= route.split('/').length) continue;
    found = { route, surface, epoch: patPrefixForPath(surface)?.epoch ?? 1 };
  }
  return found;
}

// cm:guard the one epoch rule: REST reads it for the request path, /mcp for the route a tool
// declares, so a token minted before a prefix joined the menu is refused it on both, and a route
// nested under an older mount is dated by the surface it serves (PAT_NESTED_SURFACES).
export function patEpochRefusal(
  path: string,
  tokenEpoch: number | undefined,
): PatEpochRefusal | null {
  const match = patPrefixForPath(path);
  if (!match) return null;
  const nested = patNestedSurfaceFor(path);
  const dated = nested && nested.epoch > match.epoch ? nested : null;
  const routeEpoch = dated ? dated.epoch : match.epoch;
  const held = tokenEpoch ?? 1;
  if (routeEpoch <= held) return null;
  const why = dated
    ? `${dated.route} serves the rows of ${dated.surface}, which joined the menu at grant epoch ${routeEpoch}, after this token was minted (epoch ${held}); a route is dated by the data it serves, not the mount it sits under, and a token keeps the reach it was minted with. `
    : `${match.prefix} joined '${match.resource}' at grant epoch ${routeEpoch}, after this token was minted (epoch ${held}), and a token keeps the reach it was minted with. `;
  return {
    resource: match.resource,
    prefix: match.prefix,
    surface: dated ? dated.surface : null,
    routeEpoch,
    tokenEpoch: held,
    message: `${why}Mint a new token to reach it.`,
  };
}

/** The resource whose prefixes cover this path, or null when the menu does not. */
function patResourceForPath(path: string): PatPermissionResource | null {
  return patPrefixForPath(path)?.resource ?? null;
}

function patternMatches(pattern: string, path: string): boolean {
  const want = pattern.split('/');
  const have = path.split('/');
  if (have.length < want.length) return false;
  return want.every((seg, i) => (seg.startsWith(':') ? (have[i] ?? '') !== '' : seg === have[i]));
}

/** The exclusion entry this request falls under, with its reason, or null. */
export function patUngrantableFor(
  path: string,
  method: string,
): { pattern: string; reason: string } | null {
  for (const [pattern, reason] of Object.entries(PAT_UNGRANTABLE)) {
    const space = pattern.indexOf(' ');
    const only = space === -1 ? null : pattern.slice(0, space);
    if (only !== null && only !== method.toUpperCase()) continue;
    if (patternMatches(pattern.slice(space + 1), path)) return { pattern, reason };
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
 * Permissions a grant may name beside its route groups. They open no route; the permission check
 * (`permissions/can.ts`) reads them, and a token holds them only where its grant names them, `*`
 * included.
 */
export const PAT_EXPLICIT_PERMISSIONS = TOKEN_EXPLICIT_PERMISSIONS;

/** Full access as a stated value: off the menu, so no named grant holds it. */
export const PAT_PERMISSION_ALL = '*';

export const PAT_GRANT_ALL: readonly string[] = Object.freeze([PAT_PERMISSION_ALL]);

export function patGrantIsLegacy(granted: readonly string[] | null | undefined): boolean {
  return granted === null || granted === undefined || granted.length === 0;
}

export function patGrantIsStatedFull(granted: readonly string[] | null | undefined): boolean {
  return granted?.includes(PAT_PERMISSION_ALL) ?? false;
}

export function patGrantCovers(
  granted: readonly string[] | null | undefined,
  wanted: PatPermission | null,
): boolean {
  if (wanted === null) return false;
  if (granted === null || granted === undefined) return true;
  if (granted.length === 0) return true;
  if (granted.includes(PAT_PERMISSION_ALL)) return true;
  return granted.includes(wanted);
}

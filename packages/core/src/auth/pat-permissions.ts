import type { scopeForMethod } from '../middleware/pat-rest-surface.js';

/**
 * Where a resource's routes can be fenced. `project` routes resolve a project
 * and are proven fenced by `scripts/check-pat-surface.mjs`, so a project-scoped
 * token may hold them; `account` routes resolve none, so only a token carrying
 * its owner's whole reach may.
 */
export type PatReach = 'project' | 'account';

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
  tasks: { reach: 'project', prefixes: { '/api/tasks': 1 } },
  pipeline: {
    reach: 'project',
    prefixes: {
      '/api/pipeline-runs': 1,
      '/api/jobs': 1,
      '/api/issue-step-contexts': 1,
      '/api/agent-sessions': 2,
      '/api/pipeline': 2,
      '/api/usage-records': 2,
    },
  },
  knowledge: {
    reach: 'project',
    prefixes: { '/api/knowledge': 1, '/api/knowledge-edges': 1, '/api/memory': 1 },
  },
  skills: {
    reach: 'project',
    prefixes: {
      '/api/skills': 1,
      '/api/skill-facts': 1,
      '/api/prompts': 1,
      '/api/skill-activity': 2,
    },
  },
  schedules: { reach: 'project', prefixes: { '/api/schedules': 1 } },
  projects: {
    reach: 'project',
    prefixes: { '/api/projects': 1, '/api/app-config': 2, '/api/domain-templates': 2 },
  },
  questions: { reach: 'project', prefixes: { '/api/questions': 1 } },
  runners: { reach: 'project', prefixes: { '/api/runners': 2 } },
  assistant: {
    reach: 'project',
    prefixes: { '/api/agents': 2, '/api/conversations': 2, '/api/chat-logs': 2 },
  },
  feedback: {
    reach: 'project',
    prefixes: { '/api/feedback-reports': 2, '/api/improvement-messages': 2 },
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
  'update-packets': { reach: 'account', prefixes: { '/api/update-packets': 2 } },
  admin: { reach: 'account', prefixes: { '/api/admin': 2 } },
} as const satisfies Record<string, PatResourceDeclaration>;

const PUBLIC = 'public: it reads no credential, so there is nothing for a grant to admit';
const SESSION =
  "the browser session's own lifecycle — signing up, signing in, refreshing, verifying, " +
  're-authenticating and signing out — which a token is not';
const DEVICE =
  "the paired box's own plane, admitted by the device credential minted at pairing or by a " +
  'pairing code; a personal or agent token is not a device';

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
  '/orgs':
    'the guide router is mounted at the root for its public pages and its org-guide routes ride ' +
    'along there; the token path to them is /api/orgs',
  '/mcp': 'the MCP transport, admitted by its own token door, where each tool fences itself',
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
  'GET /api/jobs/:id/turn-verdict': DEVICE,
  'POST /api/jobs/:id/events': DEVICE,
  'POST /api/jobs/:id/ack': DEVICE,
  'POST /api/jobs/:id/complete': DEVICE,
  'POST /api/jobs/:id/fail': DEVICE,
  'POST /api/jobs/:id/kill-ack': DEVICE,
  'POST /api/agent-sessions/:id/ack': DEVICE,
  'POST /api/agent-sessions/:id/events': DEVICE,
  'POST /api/agent-sessions/:id/inbox/:seq/ack': DEVICE,
  'POST /api/agent-sessions/:id/inbox/:seq/applied': DEVICE,
  'POST /api/agent-sessions/prompt-built': DEVICE,
});

export type PatPermissionResource = keyof typeof PAT_PERMISSION_RESOURCES;

export const PAT_PERMISSION_LEVELS = ['read', 'write'] as const satisfies readonly ReturnType<
  typeof scopeForMethod
>[];

export type PatPermissionLevel = (typeof PAT_PERMISSION_LEVELS)[number];

export type PatPermissionGroup = {
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

export type PatPrefixMatch = {
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

/** The resource whose prefixes cover this path, or null when the menu does not. */
export function patResourceForPath(path: string): PatPermissionResource | null {
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

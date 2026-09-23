/**
 * The audit behind `app-permissions.test.ts`: what the manifest asks for against what the code needs.
 *
 * The calls themselves are found by `app-permissions-scan.fixture.ts`, from the AST. Here rather
 * than in the test file because these are the moving parts the test plants inputs against, and a
 * file exporting them is not a test.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  GITHUB_ENDPOINTS,
  GITHUB_EVENT_SUBSCRIPTIONS,
  GITHUB_NON_REST_USES,
  type PermissionLevel,
} from './app-permissions.js';
import {
  collectGitHubCalls,
  type FoundCall,
  pathLiterals,
  unreadableRequests,
} from './app-permissions-scan.fixture.js';
import { GITHUB_DIR, sourceFiles } from './app-permissions-source.fixture.js';
import { buildAppManifest } from './connect.js';
import { PROJECTED_EVENTS } from './projection-events.js';

export {
  callsInTree,
  collectGitHubCalls,
  type FoundCall,
  hasRequestHelper,
  pathLiterals,
  unreadableRequests,
} from './app-permissions-scan.fixture.js';
export {
  DECLARATION_FILE,
  GITHUB_DIR,
  plant,
  sourceFiles,
  sourceFilesIn,
} from './app-permissions-source.fixture.js';

const SRC_ROOT = join(GITHUB_DIR, '..', '..');

/** A template like `${base}${path}`, spelled without a literal interpolation in a string. */
const tpl = (...parts: string[]) =>
  ['`', ...parts.map((p) => ['$', '{', p, '}'].join('')), '`'].join('');

/**
 * Every request whose URL the checker cannot read a path out of, listed expression by expression.
 *
 * Exempting the FILE exempts the next one too, and exempting a COUNT still lets one be swapped for
 * another — either way a GitHub call nobody prices. Listing the exact expressions makes an added,
 * removed or substituted request disagree with this list, and the check says which.
 */
export const REQUEST_HELPERS: Record<string, { transports: readonly string[]; why: string }> = {
  'client.ts': {
    transports: [tpl('base', 'path'), tpl('base', 'args.path')],
    why: 'GitHubRepoClient.get and .publish — the transport every repository call goes through',
  },
  'agent-client.ts': {
    transports: [tpl('base', 'args.path'), tpl('base', 'args.path')],
    why: 'GitHubAgentClient.json and .text — the same, for the agent face',
  },
  'repositories.ts': {
    transports: ['url'],
    why: 'githubJson — one JSON read shared by the two App-JWT listings',
  },
  'installation-permissions.ts': {
    transports: ['url'],
    why: 'askGitHub — one App-JWT read shared by the two probes here',
  },
};

/**
 * A transport's own request is not a call site, so it is not held to naming a path.
 *
 * Only the transport is dropped, and only in a file declared as holding one: a `fetch` that DOES
 * name a path is a call site wherever it sits, and `repositories.ts` makes two beside its helper.
 */
export function callsToPrice(calls: readonly FoundCall[]): FoundCall[] {
  return calls.filter((c) => !(c.kind === 'fetch' && c.unresolved && REQUEST_HELPERS[c.file]));
}

export const key = (method: string, path: string) => `${method} ${path}`;

/** Every call in one source whose `METHOD /path` no declared endpoint accounts for. */
export function orphansIn(file: string): string[] {
  const declared = new Set(GITHUB_ENDPOINTS.map((e) => key(e.method, e.path)));
  return callsToPrice(collectGitHubCalls(file))
    .filter((c) => !c.unresolved && !declared.has(key(c.method, c.path)))
    .map((c) => `${c.file}:${c.line} — ${key(c.method, c.path)}`);
}

/** The first segment of every path the tables declare — what a GitHub path in this source looks like. */
export function declaredRoots(): Set<string> {
  return new Set(GITHUB_ENDPOINTS.map((e) => e.path.split('/')[1] ?? ''));
}

/** Every GitHub path a source WRITES that no row prices, whatever expression carries it. */
export function undeclaredPathsIn(file: string): string[] {
  const declared = new Set(GITHUB_ENDPOINTS.map((e) => e.path));
  const roots = declaredRoots();
  return pathLiterals(file)
    .filter((l) => roots.has(l.path.split('/')[1] ?? '') && !declared.has(l.path))
    .map((l) => `${file}:${l.line} — ${l.path} (${l.text})`);
}

export function undeclaredPathLiterals(): string[] {
  return sourceFiles().flatMap((file) => undeclaredPathsIn(file));
}

/** Files holding a transport that `REQUEST_HELPERS` does not account for. */
export function undeclaredHelperFiles(): string[] {
  return sourceFiles().filter((f) => unreadableRequests(f).length > 0 && !REQUEST_HELPERS[f]);
}

type Manifest = {
  default_permissions: Record<string, string>;
  default_events: string[];
};

export function manifest(): Manifest {
  return buildAppManifest({
    appName: 'Forge test',
    webBaseUrl: 'https://web.example',
    apiBaseUrl: 'https://api.example',
    projectSlug: 'forge-dev',
  }) as unknown as Manifest;
}

export type PermissionFault =
  | { kind: 'missing'; permission: string; required: PermissionLevel; needers: string[] }
  | {
      kind: 'below';
      permission: string;
      required: PermissionLevel;
      requested: string;
      needers: string[];
    }
  | { kind: 'surplus'; permission: string; requested: string };

/** What the requested permissions and the required ones disagree about. */
export function auditPermissions(
  requested: Readonly<Record<string, string>>,
  required: ReadonlyMap<string, PermissionLevel>,
): PermissionFault[] {
  const faults: PermissionFault[] = [];
  const needers = (permission: string) => [
    ...GITHUB_ENDPOINTS.filter((e) => e.permission === permission).map((e) =>
      key(e.method, e.path),
    ),
    ...GITHUB_EVENT_SUBSCRIPTIONS.filter((e) => e.permission === permission).map(
      (e) => `event ${e.event}`,
    ),
    ...GITHUB_NON_REST_USES.filter((u) => u.permission === permission).map((u) => u.owner),
  ];
  for (const [permission, level] of required) {
    const held = requested[permission];
    if (held === undefined) {
      faults.push({ kind: 'missing', permission, required: level, needers: needers(permission) });
      continue;
    }
    const order = ['read', 'write', 'admin'];
    if (order.indexOf(held) < order.indexOf(level)) {
      faults.push({
        kind: 'below',
        permission,
        required: level,
        requested: held,
        needers: needers(permission),
      });
    }
  }
  for (const [permission, requestedLevel] of Object.entries(requested)) {
    if (!required.has(permission))
      faults.push({ kind: 'surplus', permission, requested: requestedLevel });
  }
  return faults;
}

export type EventFault =
  | { kind: 'unsubscribed'; event: string }
  | { kind: 'undeclared'; event: string }
  | { kind: 'unhandled'; event: string }
  | { kind: 'ungranted'; event: string; required: PermissionLevel };

/** What the subscribed events, the declared ones and the handled ones disagree about. */
export function auditEvents(
  subscribed: readonly string[],
  handled: ReadonlySet<string>,
  requested: Readonly<Record<string, string>>,
): EventFault[] {
  const faults: EventFault[] = [];
  const declared = new Set(GITHUB_EVENT_SUBSCRIPTIONS.map((e) => e.event));
  for (const event of declared) {
    if (!subscribed.includes(event)) faults.push({ kind: 'unsubscribed', event });
    if (!handled.has(event)) faults.push({ kind: 'unhandled', event });
  }
  for (const event of subscribed)
    if (!declared.has(event)) faults.push({ kind: 'undeclared', event });
  const order = ['read', 'write', 'admin'];
  for (const e of GITHUB_EVENT_SUBSCRIPTIONS) {
    const held = requested[e.permission];
    if (held === undefined || order.indexOf(held) < order.indexOf(e.level)) {
      faults.push({ kind: 'ungranted', event: e.event, required: e.level });
    }
  }
  return faults;
}

/** Every event some handler in this repository acts on. */
export function handledEvents(): Set<string> {
  const adapter = readFileSync(join(SRC_ROOT, 'webhooks', 'github-adapter.ts'), 'utf8');
  const direct = [...adapter.matchAll(/eventType === '([a-z_]+)'/g)].map((m) => m[1] as string);
  return new Set<string>([...PROJECTED_EVENTS, ...direct]);
}

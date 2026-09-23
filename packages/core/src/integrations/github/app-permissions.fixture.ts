/**
 * The checker behind `app-permissions.test.ts`: what a GitHub call looks like in this repository's
 * own source, and how one is read back out of it.
 *
 * Here rather than in the test file because these are the moving parts the test plants inputs
 * against, and a file exporting them is not a test.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  GITHUB_ENDPOINTS,
  GITHUB_EVENT_SUBSCRIPTIONS,
  GITHUB_NON_REST_USES,
  type PermissionLevel,
} from './app-permissions.js';
import { buildAppManifest } from './connect.js';
import { PROJECTED_EVENTS } from './projection-events.js';

const SRC_ROOT = join(import.meta.dirname, '..', '..');

/** A template like `${base}${path}`, spelled without a literal interpolation in a string. */
const tpl = (...parts: string[]) =>
  ['`', ...parts.map((p) => ['$', '{', p, '}'].join('')), '`'].join('');

/**
 * Every request whose URL the checker cannot read a path out of, listed expression by expression.
 *
 * Exempting the FILE exempts the next one too, and exempting a COUNT still lets one be swapped for
 * another — either way a GitHub call nobody prices, with every test here green. Listing the exact
 * expressions makes an added, removed or substituted request disagree with this list, and the check
 * says which. Reformatting one fails the check until the list is updated: a loud failure with an
 * obvious fix, against a hole that would be silent.
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

const TEMPLATE = '`(?:[^`\\\\]|\\\\.)*`';
const QUOTED = `(?:${TEMPLATE}|'[^'\\n]*'|"[^"\\n]*")`;

/** Where a GitHub path can appear, and how the method that goes with it is known. */
const PATH_SITES = [
  {
    // `path:` carries the expression; the method comes out of the object literal around it.
    re: new RegExp(
      String.raw`\bpath:\s*((?:${QUOTED}|[A-Za-z_$][\w$]*\([^)]*\))(?:\s*\+\s*(?:${TEMPLATE}))*)`,
      'g',
    ),
    method: 'enclosing' as const,
    kind: 'path' as const,
  },
  {
    re: new RegExp(String.raw`\bclient\.get\s*(?:<[^;]*?>)?\s*\(\s*(${TEMPLATE})`, 'g'),
    method: 'GET' as const,
    kind: 'path' as const,
  },
  {
    re: new RegExp(
      String.raw`\b(?:doFetch|fetch|githubJson)\s*(?:<[\s\S]*?>)?\s*\(\s*(?:doFetch\s*,\s*)?(${TEMPLATE})`,
      'g',
    ),
    method: 'following' as const,
    kind: 'fetch' as const,
  },
];

/**
 * The file with every comment blanked and its line count kept.
 *
 * A comment naming a path is prose about a call, never a call: this module's own table says
 * "keyed by method AND path: `GET /repos/…`" in a doc block, and a checker reading that as a call
 * site reports a call nobody makes.
 */
export function withoutComments(text: string): string {
  const blank = (m: string) => m.replace(/[^\n]/g, ' ');
  return text.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/\/\/[^\n]*/g, blank);
}

const PREFIXES: Array<[RegExp, string]> = [
  [/\$\{\s*repoPath\(client\)\s*\}/g, '/repos/:p/:p'],
  [/\brepoPath\(client\)/g, '/repos/:p/:p'],
  [/\$\{\s*client\.fullName\s*\}/g, ':p/:p'],
  [/^https:\/\/api\.github\.com/, ''],
  [/^\$\{\s*(?:base|GITHUB_API_BASE)\s*\}/, ''],
];

export function resolvePath(raw: string): string {
  let s = raw.replace(/`\s*\+\s*`/g, '').trim();
  if (/^(['"`]).*\1$/s.test(s)) s = s.slice(1, -1);
  for (const [re, to] of PREFIXES) s = s.replace(re, to);
  return s.replace(/\$\{[^}]*\}/g, ':p').split('?')[0] ?? '';
}

/** The object literal a `path:` property sits in, found by counting braces outwards. */
export function enclosingObject(text: string, at: number): string {
  let depth = 0;
  let open = -1;
  for (let i = at; i >= 0; i -= 1) {
    if (text[i] === '}') depth += 1;
    else if (text[i] === '{') {
      if (depth === 0) {
        open = i;
        break;
      }
      depth -= 1;
    }
  }
  if (open < 0) return '';
  depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1;
    else if (text[i] === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(open, i + 1);
    }
  }
  return text.slice(open);
}

/** The options object a `fetch(url, { … })` carries, or '' where it carries none. */
export function followingObject(text: string, from: number): string {
  const next = text.slice(from, from + 400);
  const brace = next.indexOf('{');
  const close = next.indexOf(')');
  if (brace < 0 || (close >= 0 && close < brace)) return '';
  return enclosingObject(text, from + brace + 1);
}

export interface FoundCall {
  file: string;
  line: number;
  raw: string;
  path: string;
  method: string;
  /** `fetch` is the shape a request HELPER also wears; the other two are always call sites. */
  kind: 'path' | 'fetch';
  /** Why this call could not be read, or null. */
  unresolved: string | null;
}

export function methodFrom(block: string, fallback: string | null): string | null {
  const named = /\bmethod:\s*'(GET|POST|PATCH|PUT|DELETE)'/.exec(block);
  if (named?.[1]) return named[1];
  // `client.text` is a GET by its own type, and it is the one call shape carrying no `method`.
  if (/\bmaxBytes:/.test(block)) return 'GET';
  return fallback;
}

/** Every GitHub call one source file makes, as `METHOD /path`, or the reason one could not be read. */
export function collectGitHubCalls(source: string, file: string): FoundCall[] {
  const text = withoutComments(source);
  const out: FoundCall[] = [];
  for (const site of PATH_SITES) {
    site.re.lastIndex = 0;
    let m = site.re.exec(text);
    for (; m !== null; m = site.re.exec(text)) {
      const raw = m[1] ?? '';
      const at = m.index + m[0].indexOf(raw);
      const line = text.slice(0, at).split('\n').length;
      const path = resolvePath(raw);
      const method =
        site.method === 'enclosing'
          ? methodFrom(enclosingObject(text, at), null)
          : site.method === 'following'
            ? methodFrom(followingObject(text, at + raw.length), 'GET')
            : site.method;
      const unresolved = !path.startsWith('/')
        ? `the path expression does not resolve to a GitHub path: ${raw}`
        : method === null
          ? `the call names no HTTP method: ${raw}`
          : null;
      out.push({ file, line, raw, path, method: method ?? '?', kind: site.kind, unresolved });
    }
  }
  return out;
}

export const GITHUB_DIR = join(SRC_ROOT, 'integrations', 'github');

/**
 * `app-permissions.ts` is the table itself and calls nothing, so reading its rows as call sites
 * would have the checker price its own declarations. Asserted below rather than assumed.
 */
export const DECLARATION_FILE = 'app-permissions.ts';

export function sourceFiles(): string[] {
  return readdirSync(GITHUB_DIR).filter(
    (f) =>
      f.endsWith('.ts') &&
      !f.endsWith('.test.ts') &&
      !f.endsWith('.fixture.ts') &&
      f !== DECLARATION_FILE,
  );
}

export function callsInTree(): FoundCall[] {
  return sourceFiles().flatMap((file) =>
    collectGitHubCalls(readFileSync(join(GITHUB_DIR, file), 'utf8'), file),
  );
}

/**
 * The two shapes that hide a URL, with the line each sits on so a failure can point at it.
 *
 * Neither is counted twice: the first branch takes only arguments that are not templates, which is
 * exactly what the second does not see.
 */
export function unreadableRequests(
  file: string,
  source: string,
): Array<{ line: number; raw: string }> {
  const text = withoutComments(source);
  const out: Array<{ line: number; raw: string }> = [];
  for (const m of text.matchAll(/\b(?:doFetch|fetch)\s*\(/g)) {
    const after = text.slice(m.index + m[0].length).trimStart();
    if (after.startsWith('`')) continue;
    out.push({
      line: text.slice(0, m.index).split('\n').length,
      raw: after.split(/[,)\n]/)[0] ?? '',
    });
  }
  for (const c of collectGitHubCalls(source, file)) {
    if (c.kind === 'fetch' && c.unresolved) out.push({ line: c.line, raw: c.raw });
  }
  return out.sort((a, b) => a.line - b.line);
}

/** Whether this file holds any of them at all. */
export function hasRequestHelper(file: string, source: string): boolean {
  return unreadableRequests(file, source).length > 0;
}

/**
 * A helper's own transport is not a call site, so it is not held to naming a path.
 *
 * Only the transport is dropped, and only in a file declared as holding one: a `fetch` that DOES
 * name a path is a call site wherever it sits, and `repositories.ts` makes two beside its helper.
 */
export function callsToPrice(calls: readonly FoundCall[]): FoundCall[] {
  return calls.filter((c) => !(c.kind === 'fetch' && c.unresolved && REQUEST_HELPERS[c.file]));
}

export const key = (method: string, path: string) => `${method} ${path}`;

type Manifest = {
  default_permissions: Record<string, string>;
  default_events: string[];
};

export function manifest(): Manifest {
  const built = buildAppManifest({
    appName: 'Forge test',
    webBaseUrl: 'https://web.example',
    apiBaseUrl: 'https://api.example',
    projectSlug: 'forge-dev',
  }) as unknown as Manifest;
  return built;
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

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

/** The text from `from` up to whichever of `stops` this expression's own bracket depth returns to zero at. */
function untilTopLevel(text: string, from: number, stops: string): string {
  let depth = 0;
  let i = from;
  for (; i < text.length; i += 1) {
    const c = text[i];
    if (c === undefined) break;
    if (depth === 0 && stops.includes(c)) break;
    if (c === '(' || c === '{' || c === '[') depth += 1;
    else if (c === ')' || c === '}' || c === ']') depth -= 1;
  }
  return text.slice(from, i).trim();
}

/** The value after a property key, up to the point this property's own bracket depth returns to zero. */
function propertyValue(text: string, from: number): string {
  return untilTopLevel(text, from, ',}');
}

/** The argument between a call's own parentheses, a formatter's trailing comma trimmed off. */
function callArgument(text: string, openAt: number): string {
  let depth = 1;
  let i = openAt;
  for (; i < text.length && depth > 0; i += 1) {
    if (text[i] === '(') depth += 1;
    else if (text[i] === ')') depth -= 1;
  }
  return text
    .slice(openAt, i - 1)
    .trim()
    .replace(/,$/, '')
    .trim();
}

/** Every `path:` value inside a call's own argument object, whatever expression it is. */
function pathPropertyValues(text: string): Array<{ at: number; raw: string }> {
  const out: Array<{ at: number; raw: string }> = [];
  const re = /\bpath:\s*/g;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    const at = m.index + m[0].length;
    if (inArgumentObject(text, at)) out.push({ at, raw: propertyValue(text, at) });
  }
  return out;
}

/** Every `client.get(...)` argument, whatever expression it is. */
function clientGetValues(text: string): Array<{ at: number; raw: string }> {
  const out: Array<{ at: number; raw: string }> = [];
  const re = /\bclient\.get\b\s*(?:<[^;]*?>)?\s*\(/g;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    const at = m.index + m[0].length;
    out.push({ at, raw: callArgument(text, at) });
  }
  return out;
}

/** True where `name(` is that name's own declaration, never a call to it — `async function githubJson(`. */
function isDeclarationSite(text: string, nameAt: number): boolean {
  return /\bfunction\s+$/.test(text.slice(Math.max(0, nameAt - 20), nameAt));
}

/**
 * Every `doFetch`/`fetch`/`githubJson` argument that carries the URL, whatever expression it is.
 * `githubJson(doFetch, url, …)` takes it second; the other two take it first.
 */
function fetchValues(text: string): Array<{ at: number; raw: string }> {
  const out: Array<{ at: number; raw: string }> = [];
  const re = /\b(?:doFetch|fetch|githubJson)\b\s*(?:<[\s\S]*?>)?\s*\(\s*/g;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    if (isDeclarationSite(text, m.index)) continue;
    let at = m.index + m[0].length;
    const skip = /^doFetch\s*,\s*/.exec(text.slice(at, at + 40));
    if (skip) at += skip[0].length;
    out.push({ at, raw: untilTopLevel(text, at, ',)') });
  }
  return out;
}

/** Where a GitHub path can appear, and how the method that goes with it is known. */
const PATH_SITES: Array<{
  values: (text: string) => Array<{ at: number; raw: string }>;
  method: 'enclosing' | 'GET' | 'following';
  kind: 'path' | 'fetch';
}> = [
  { values: pathPropertyValues, method: 'enclosing', kind: 'path' },
  { values: clientGetValues, method: 'GET', kind: 'path' },
  { values: fetchValues, method: 'following', kind: 'fetch' },
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

function enclosingOpen(text: string, at: number): number {
  let depth = 0;
  for (let i = at; i >= 0; i -= 1) {
    if (text[i] === '}') depth += 1;
    else if (text[i] === '{') {
      if (depth === 0) return i;
      depth -= 1;
    }
  }
  return -1;
}

/**
 * True where the object holding this property is a call's argument.
 *
 * `path:` also spells a TYPE — an interface member, a parameter, a generic — and a checker reading
 * those as calls would price every declaration in this directory. An argument object opens right
 * after `(`; a type's opens after a name or a `:`.
 */
export function inArgumentObject(text: string, at: number): boolean {
  const open = enclosingOpen(text, at);
  return open >= 0 && /\(\s*$/.test(text.slice(Math.max(0, open - 40), open));
}

/** The object literal a `path:` property sits in, found by counting braces outwards. */
export function enclosingObject(text: string, at: number): string {
  const open = enclosingOpen(text, at);
  if (open < 0) return '';
  let depth = 0;
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

/** The record for one call, wherever its `{ at, raw }` came from. */
function callFromRaw(
  text: string,
  file: string,
  at: number,
  raw: string,
  methodKind: 'enclosing' | 'GET' | 'following',
  kind: 'path' | 'fetch',
): FoundCall {
  const line = text.slice(0, at).split('\n').length;
  const path = resolvePath(raw);
  const method =
    methodKind === 'enclosing'
      ? methodFrom(enclosingObject(text, at), null)
      : methodKind === 'following'
        ? methodFrom(followingObject(text, at + raw.length), 'GET')
        : methodKind;
  const unresolved = !path.startsWith('/')
    ? `the path expression does not resolve to a GitHub path: ${raw}`
    : method === null
      ? `the call names no HTTP method: ${raw}`
      : null;
  return { file, line, raw, path, method: method ?? '?', kind, unresolved };
}

/** Every GitHub call one source file makes, as `METHOD /path`, or the reason one could not be read. */
export function collectGitHubCalls(source: string, file: string): FoundCall[] {
  const text = withoutComments(source);
  const out: FoundCall[] = [];
  for (const site of PATH_SITES) {
    for (const { at, raw } of site.values(text)) {
      out.push(callFromRaw(text, file, at, raw, site.method, site.kind));
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

/** Every request whose URL `collectGitHubCalls` could not read, with the line it sits on. */
export function unreadableRequests(
  file: string,
  source: string,
): Array<{ line: number; raw: string }> {
  return collectGitHubCalls(source, file)
    .filter((c) => c.kind === 'fetch' && c.unresolved)
    .map((c) => ({ line: c.line, raw: c.raw }))
    .sort((a, b) => a.line - b.line);
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

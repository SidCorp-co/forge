/**
 * The sources `app-permissions.test.ts` plants into the checker's own program.
 *
 * Every plant sits here, in a module the test imports: the program is built on the first read, and
 * `plant` refuses one registered after that rather than silently leaving it out.
 */

import { plant, REQUEST_HELPERS } from './app-permissions.fixture.js';

/** `${name}`, spelled so this file's own source carries no interpolation. */
export const interp = (name: string) => ['$', '{', name, '}'].join('');
export const REPO = `/repos/${interp('client.owner')}/${interp('client.repo')}`;

export const AS_FILE = (lines: string[]) =>
  ["import type { GitHubRepoClient } from './client.js';", ...lines].join('\n');

export const UNRESOLVED = plant(
  'planted-unresolved.ts',
  AS_FILE([
    'declare function somewhereElse(client: GitHubRepoClient): string;',
    'export async function f(client: GitHubRepoClient) {',
    '  await client.publish({',
    "    op: 'lookup',",
    "    method: 'GET',",
    '    path: somewhereElse(client),',
    '  });',
    '}',
  ]),
);

export const NO_METHOD = plant(
  'planted-no-method.ts',
  [
    "import type { GitHubAgentClient } from './agent-client.js';",
    'export async function f(client: GitHubAgentClient) {',
    `  await client.json({ path: \`${REPO}/pulls\` });`,
    '}',
  ].join('\n'),
);

export const VARIABLE_PATH = plant(
  'planted-variable-path.ts',
  AS_FILE([
    'declare function somewhere(): string;',
    'export async function f(client: GitHubRepoClient) {',
    '  const endpoint = somewhere();',
    "  await client.publish({ op: 'lookup', method: 'POST', path: endpoint });",
    '}',
  ]),
);

export const CONCATENATED = plant(
  'planted-concatenated.ts',
  AS_FILE([
    'declare function repoPath(client: GitHubRepoClient): string;',
    'export async function f(client: GitHubRepoClient) {',
    '  const prefix = repoPath(client);',
    "  await client.publish({ op: 'merge', method: 'PUT', path: prefix + '/merge' });",
    '}',
  ]),
);

export const BARE_GET = plant(
  'planted-bare-get.ts',
  AS_FILE([
    'declare const endpoint: string;',
    'export async function readIt(client: GitHubRepoClient) {',
    '  return client.get(endpoint);',
    '}',
  ]),
);

export const READABLE_GET = plant(
  'planted-readable-get.ts',
  AS_FILE([
    'export async function readIt(client: GitHubRepoClient) {',
    `  return client.get(\`/repos/${interp('client.fullName')}/pulls\`);`,
    '}',
  ]),
);

export const TRAILING_COMMA = plant(
  'planted-trailing-comma.ts',
  AS_FILE([
    'declare const endpoint: string;',
    'export async function readIt(client: GitHubRepoClient) {',
    '  return client.get(',
    '    endpoint,',
    '  );',
    '}',
  ]),
);

export const DECLARATIONS_ONLY = plant(
  'planted-declarations-only.ts',
  [
    'export interface Args {',
    '  path: string;',
    "  method: 'GET' | 'POST';",
    '}',
    'export type Alias = { path: string };',
    'export function ask(path: string, next: Alias) {',
    '  return [path, next];',
    '}',
  ].join('\n'),
);

/** A transport of the file's own making, and a call to it: both halves have to be read. */
export const GITHUB_JSON = plant(
  'planted-github-json.ts',
  [
    'export async function githubJson(doFetch: typeof fetch, url: string, authorization: string) {',
    '  return doFetch(url, { headers: { authorization } });',
    '}',
    'declare const someUrl: string;',
    'export async function readIt(doFetch: typeof fetch, token: string) {',
    '  return githubJson(doFetch, someUrl, token);',
    '}',
  ].join('\n'),
);

export const ASSIGNED_ARGS = plant(
  'planted-assigned-args.ts',
  AS_FILE([
    'declare function somewhereElse(client: GitHubRepoClient): string;',
    'export async function f(client: GitHubRepoClient) {',
    "  const args = { op: 'lookup' as const, method: 'GET' as const, path: somewhereElse(client) };",
    '  await client.publish(args);',
    '}',
  ]),
);

export const SHORTHAND = plant(
  'planted-shorthand.ts',
  AS_FILE([
    'declare function queuePath(client: GitHubRepoClient): string;',
    'export async function f(client: GitHubRepoClient) {',
    "  const op = 'lookup' as const;",
    "  const method = 'GET' as const;",
    '  const path = queuePath(client);',
    '  await client.publish({ op, method, path });',
    '}',
  ]),
);

export const RETURNED_ARGS = plant(
  'planted-returned-args.ts',
  AS_FILE([
    'declare function queuePath(client: GitHubRepoClient): string;',
    'function queueArgs(client: GitHubRepoClient) {',
    "  return { op: 'lookup' as const, method: 'GET' as const, path: queuePath(client) };",
    '}',
    'export async function f(client: GitHubRepoClient) {',
    '  await client.publish(queueArgs(client));',
    '}',
  ]),
);

/** The harm ISS-1153 was filed against, written in the shape round three found invisible. */
export const REAL_UNDECLARED_PATH = plant(
  'planted-real-undeclared-path.ts',
  AS_FILE([
    'export async function f(client: GitHubRepoClient) {',
    "  const op = 'lookup' as const;",
    "  const method = 'GET' as const;",
    `  const path = \`${REPO}/merge-queue\`;`,
    '  await client.publish({ op, method, path });',
    '}',
  ]),
);

/** The one way a transport call escapes the symbol match: a receiver with no type to read. */
export const UNTYPED_RECEIVER = plant(
  'planted-untyped-receiver.ts',
  [
    'declare const anything: any;',
    'export async function f() {',
    "  await anything.publish({ op: 'lookup', method: 'GET', path: '/repos/a/b' });",
    '}',
  ].join('\n'),
);

export const CLIENT_TRANSPORTS = REQUEST_HELPERS['client.ts']?.transports ?? [];

export const transportFile = (name: string, urls: readonly string[]) =>
  plant(
    name,
    [
      'declare const headers: Record<string, string>;',
      'declare const base: string;',
      'declare const path: string;',
      'declare const args: { path: string };',
      'declare const computedGitHubUrl: string;',
      'export async function send() {',
      ...urls.map((u) => `  await fetch(${u}, { headers });`),
      '}',
    ].join('\n'),
  );

export const TRANSPORT_ADDED = transportFile('planted-transport-added.ts', [
  ...CLIENT_TRANSPORTS,
  'computedGitHubUrl',
]);
export const TRANSPORT_SWAPPED = transportFile('planted-transport-swapped.ts', [
  CLIENT_TRANSPORTS[0] as string,
  'computedGitHubUrl',
]);
export const TRANSPORT_PROPERTY = transportFile('planted-transport-property.ts', [
  'computedGitHubUrl',
  'base + path',
]);

/** A transport extracted into a name, and one destructured out: consult 1d3280 F1. */
export const EXTRACTED_MEMBER = plant(
  'planted-extracted-member.ts',
  AS_FILE([
    'declare function queuePath(client: GitHubRepoClient): string;',
    'export async function f(client: GitHubRepoClient) {',
    '  const publish = client.publish;',
    "  await publish({ op: 'lookup', method: 'GET', path: queuePath(client) });",
    '}',
  ]),
);

export const DESTRUCTURED_MEMBER = plant(
  'planted-destructured-member.ts',
  AS_FILE([
    'declare function queuePath(client: GitHubRepoClient): string;',
    'export async function f(client: GitHubRepoClient) {',
    '  const { publish } = client;',
    "  await publish({ op: 'lookup', method: 'GET', path: queuePath(client) });",
    '}',
  ]),
);

/** A transport written as an arrow property rather than a method: consult 1d3280 F2. */
export const ARROW_TRANSPORT = plant(
  'planted-arrow-transport.ts',
  [
    'declare const unreadableUrl: string;',
    'declare function queuePath(): string;',
    'export interface Conduit {',
    "  send(args: { method: 'GET'; path: string }): Promise<unknown>;",
    '}',
    'export function make(): Conduit {',
    '  return { send: async (args) => fetch(unreadableUrl, { method: args.method }) };',
    '}',
    'export async function use(conduit: Conduit) {',
    "  await conduit.send({ method: 'GET', path: queuePath() });",
    '}',
  ].join('\n'),
);

/** A network boundary whose return type is spelled through an alias: consult 1d3280 F3. */
export const ALIASED_RESPONSE = plant(
  'planted-aliased-response.ts',
  [
    'type ResponsePromise = Promise<Response>;',
    'declare const doSend: (url: string) => ResponsePromise;',
    'declare function queuePath(): string;',
    'export async function conduit(url: string) {',
    '  return doSend(url);',
    '}',
    'export async function use() {',
    '  return conduit(queuePath());',
    '}',
  ].join('\n'),
);

/** A transport carrying its method in a parameter of its own: consult 1d3280 F4. */
export const SCALAR_METHOD = plant(
  'planted-scalar-method.ts',
  [
    'declare const unreadableUrl: string;',
    "export async function send(path: string, method: 'GET' | 'POST') {",
    '  return fetch(unreadableUrl, { method });',
    '}',
    'export async function use() {',
    "  return send('/repos/a/b/merge-queue', 'POST');",
    '}',
  ].join('\n'),
);

/** A value wearing a declared hole's spelling and carrying its own: consult 1d3280 F5. */
export const SHADOWED_HOLE = plant(
  'planted-shadowed-hole.ts',
  [
    'declare const doFetch: typeof fetch;',
    "const client = { fullName: 'a/b/c' };",
    'export async function f() {',
    `  return doFetch(\`/repos/${interp('client.fullName')}/pulls\`);`,
    '}',
  ].join('\n'),
);

/** The untyped residual reached by an element access: consult 1d3280 F6. */
export const UNTYPED_ELEMENT_ACCESS = plant(
  'planted-untyped-element-access.ts',
  [
    'declare const anything: any;',
    'export async function f() {',
    "  await anything['publish']({ op: 'lookup', method: 'GET', path: '/repos/a/b' });",
    '}',
  ].join('\n'),
);

/** A transport alias two hops from the member it holds: consult ef12bd F1. */
export const TWO_HOP_ALIAS = plant(
  'planted-two-hop-alias.ts',
  AS_FILE([
    'declare const endpoint: string;',
    'export async function f(client: GitHubRepoClient) {',
    '  const first = client.publish;',
    '  const send = first;',
    "  await send({ op: 'lookup', method: 'GET', path: endpoint });",
    '}',
  ]),
);

/** A spread that could overwrite a path the checker read: consult ef12bd F2. */
export const SPREAD_OVERRIDE = plant(
  'planted-spread-override.ts',
  AS_FILE([
    'export async function f(client: GitHubRepoClient, override: { path?: string }) {',
    `  await client.publish({ op: 'lookup', method: 'GET', path: \`${REPO}\`, ...override });`,
    '}',
  ]),
);

/** The same spread, overwritten in turn by a property the checker CAN read: consult ef12bd F2. */
export const SPREAD_THEN_PATH = plant(
  'planted-spread-then-path.ts',
  AS_FILE([
    'export async function f(client: GitHubRepoClient, override: { path?: string }) {',
    `  await client.publish({ op: 'lookup', method: 'GET', ...override, path: \`${REPO}\` });`,
    '}',
  ]),
);

/** A hole standing for more than one path segment: consult ef12bd F3. */
export const MULTI_SEGMENT_HOLE = plant(
  'planted-multi-segment-hole.ts',
  AS_FILE([
    'declare function reviewTail(n: number): string;',
    'export async function f(client: GitHubRepoClient, n: number) {',
    `  return client.get(\`${REPO}/pulls/${interp('reviewTail(n)')}\`);`,
    '}',
  ]),
);

/** The same shape where the hole is proven to carry no separator: consult ef12bd F3. */
export const ENCODED_SEGMENT = plant(
  'planted-encoded-segment.ts',
  AS_FILE([
    'export async function f(client: GitHubRepoClient, ref: string) {',
    `  return client.get(\`${REPO}/pulls/${interp('encodeURIComponent(ref)')}\`);`,
    '}',
  ]),
);

/** A direct request whose method is a value rather than a literal: consult ef12bd F4. */
export const DYNAMIC_METHOD = plant(
  'planted-dynamic-method.ts',
  [
    'declare const doFetch: typeof fetch;',
    "export async function f(method: 'GET' | 'DELETE') {",
    "  return doFetch('/repos/a/b/branches/main/protection', { method });",
    '}',
  ].join('\n'),
);

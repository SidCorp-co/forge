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

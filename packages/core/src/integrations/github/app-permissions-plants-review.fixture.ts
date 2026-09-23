/**
 * The sources planted for what the reviews of this change found the checker still missing.
 *
 * One per finding, each with the positive control beside it that the refusal must not swallow.
 * `app-permissions-plants.fixture.ts` holds the shapes the checker was first written against.
 */

import { plant } from './app-permissions.fixture.js';
import { AS_FILE, interp, REPO } from './app-permissions-plants.fixture.js';

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

/** `encodeURI` leaves the separator alone, whatever its name suggests: consult 088b75 F1. */
export const ENCODE_URI_HOLE = plant(
  'planted-encode-uri-hole.ts',
  AS_FILE([
    'export async function f(client: GitHubRepoClient, tail: string) {',
    `  return client.get(\`${REPO}/pulls/${interp('encodeURI(tail)')}\`);`,
    '}',
  ]),
);

/** The encoder pulled out into a name of its own, which is still one segment. */
export const EXTRACTED_ENCODING = plant(
  'planted-extracted-encoding.ts',
  AS_FILE([
    'export async function f(client: GitHubRepoClient, ref: string) {',
    '  const segment = encodeURIComponent(ref);',
    `  return client.get(\`${REPO}/pulls/${interp('segment')}\`);`,
    '}',
  ]),
);

/** A spread inside a spread, whose own refusal the recursion must carry out: consult 088b75 F2. */
export const NESTED_SPREAD_OVERRIDE = plant(
  'planted-nested-spread-override.ts',
  AS_FILE([
    'export async function f(client: GitHubRepoClient, override: { path?: string }) {',
    `  await client.publish({ op: 'lookup', method: 'GET', path: \`${REPO}\`, ...{ ...override } });`,
    '}',
  ]),
);

/** A spread that may carry the METHOD of a direct request the checker otherwise reads. */
export const SPREAD_METHOD = plant(
  'planted-spread-method.ts',
  [
    'declare const doFetch: typeof fetch;',
    "export async function f(override: { method?: 'GET' | 'DELETE' }) {",
    "  return doFetch('/repos/a/b/branches/main/protection', { method: 'GET', ...override });",
    '}',
  ].join('\n'),
);

/** The same request with the method written after that spread, as the runtime would keep it. */
export const SPREAD_THEN_METHOD = plant(
  'planted-spread-then-method.ts',
  [
    'declare const doFetch: typeof fetch;',
    "export async function f(override: { method?: 'GET' | 'DELETE' }) {",
    "  return doFetch('/repos/a/b/branches/main/protection', { ...override, method: 'GET' });",
    '}',
  ].join('\n'),
);

/** A binding written to after it is set, which its initializer no longer names: consult e3e9f1 F1. */
export const MUTATED_PATH = plant(
  'planted-mutated-path.ts',
  AS_FILE([
    'export async function f(client: GitHubRepoClient, branch: string) {',
    `  let endpoint = \`${REPO}\`;`,
    `  endpoint += \`/branches/${interp('encodeURIComponent(branch)')}/protection\`;`,
    '  return client.get(endpoint);',
    '}',
  ]),
);

/** The same path bound once, which nothing can write to after: consult e3e9f1 F1. */
export const CONST_PATH = plant(
  'planted-const-path.ts',
  AS_FILE([
    'export async function f(client: GitHubRepoClient, branch: string) {',
    `  const endpoint = \`${REPO}/branches/${interp('encodeURIComponent(branch)')}/protection\`;`,
    '  return client.get(endpoint);',
    '}',
  ]),
);

/** A transport held in a property of an object of its own: consult e3e9f1 F2. */
export const OBJECT_HELD_TRANSPORT = plant(
  'planted-object-held-transport.ts',
  AS_FILE([
    'declare const endpoint: string;',
    'export async function f(client: GitHubRepoClient) {',
    '  const api = { send: client.publish };',
    "  await api.send({ op: 'lookup', method: 'POST', path: endpoint });",
    '}',
  ]),
);

/** A method named by a quoted key, which is the same key: consult e3e9f1 F3. */
export const QUOTED_METHOD = plant(
  'planted-quoted-method.ts',
  [
    'declare const doFetch: typeof fetch;',
    'declare const headers: Record<string, string>;',
    'export async function f(branch: string) {',
    `  return doFetch(\`/repos/a/b/branches/${interp('encodeURIComponent(branch)')}/protection\`, {`,
    "    'method': 'DELETE',",
    '    headers,',
    '  });',
    '}',
  ].join('\n'),
);

/** A key computed out of something the checker cannot read: consult e3e9f1 F3. */
export const COMPUTED_KEY = plant(
  'planted-computed-key.ts',
  AS_FILE([
    'declare const which: string;',
    'export async function f(client: GitHubRepoClient) {',
    `  await client.publish({ op: 'lookup', method: 'GET', path: \`${REPO}\`, [which]: '/repos/a/b' });`,
    '}',
  ]),
);

/** A `const` object whose property is written to after: consult 50a080 F1. */
export const MUTATED_ARGS = plant(
  'planted-mutated-args.ts',
  AS_FILE([
    'export async function f(client: GitHubRepoClient, branch: string) {',
    `  const args = { op: 'lookup' as const, method: 'GET' as const, path: \`${REPO}\` };`,
    `  args.path += \`/branches/${interp('encodeURIComponent(branch)')}/protection\`;`,
    '  await client.publish(args);',
    '}',
  ]),
);

/** A transport held by a shorthand property of an object: consult 50a080 F2. */
export const SHORTHAND_HELD_TRANSPORT = plant(
  'planted-shorthand-held-transport.ts',
  AS_FILE([
    'declare const endpoint: string;',
    'export async function f(client: GitHubRepoClient) {',
    '  const publish = client.publish;',
    '  const api = { publish };',
    "  await api.publish({ op: 'lookup', method: 'POST', path: endpoint });",
    '}',
  ]),
);

/** A scalar property of an object written to after it is built: consult 52ee7d F1. */
export const MUTATED_PROPERTY = plant(
  'planted-mutated-property.ts',
  AS_FILE([
    'export async function f(client: GitHubRepoClient, branch: string) {',
    `  const args = { path: \`${REPO}\` };`,
    `  args.path += \`/branches/${interp('encodeURIComponent(branch)')}/protection\`;`,
    '  return client.get(args.path);',
    '}',
  ]),
);

/** The same property on an object nothing writes to: consult 52ee7d F1. */
export const STABLE_PROPERTY = plant(
  'planted-stable-property.ts',
  AS_FILE([
    'export async function f(client: GitHubRepoClient) {',
    `  const args = { path: \`${REPO}/pulls\` };`,
    '  return client.get(args.path);',
    '}',
  ]),
);

/** A transport bound to its receiver, which moves no argument: consult 52ee7d F2. */
export const BOUND_TRANSPORT = plant(
  'planted-bound-transport.ts',
  AS_FILE([
    'declare const endpoint: string;',
    'export async function f(client: GitHubRepoClient) {',
    '  const send = client.publish.bind(client);',
    "  await send({ op: 'lookup', method: 'POST', path: endpoint });",
    '}',
  ]),
);

/** The same bind fixing an argument as well, which moves every other one: consult 52ee7d F2. */
export const SHIFTED_TRANSPORT = plant(
  'planted-shifted-transport.ts',
  AS_FILE([
    'export async function f(client: GitHubRepoClient) {',
    `  const send = client.get.bind(client, \`${REPO}/pulls\`);`,
    '  await send();',
    '}',
  ]),
);

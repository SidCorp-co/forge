/**
 * One sign-in with a testing profile's actor secret, made by core when the secret is written
 * (ISS-937), so a value that no longer signs in is found at the write and not by a judge's 401.
 *
 * It reads the secret exactly as `forge-runner judge-login` does (ISS-959,
 * `packages/runner/crates/forge-runner/src/cmd/judge_login/session.rs`: `parse_secret`,
 * `sign_in_url`, `sign_in`), so a value that passes here is one judge-login can sign in with:
 * - a JSON object naming `password`; a secret with none (an API key, a token) is the credential
 *   itself and is not probed;
 * - the account under exactly one of `ACCOUNT_FIELDS`, sent under that name (`identifier` is the
 *   Strapi convention, which SidDesk's sign-in reads);
 * - `loginRoute`, `[POST ]<https URL | /path>`: a path signs in at the origin of the judged
 *   deployment that answers it (the service whose longest `routes` prefix claims it, else `url`);
 * - optional, for a sign-in that is no `{<account field>, password}` POST (ISS-1141, epod's GraphQL
 *   mutation): `loginBody`, a JSON object sent as the body, whose string leaves that are exactly
 *   `$account` or `$password` become the account and password; and `tokenPath`, the JSON pointer
 *   the answer's token is read at in place of `TOKEN_PATHS`.
 *
 * The value leaves only as the request body the adapter (`integrations/deploy/sign-in-probe.ts`)
 * sends to that one origin, following no redirect: no answer, refusal, log line or stored row holds
 * it, its account, its length or any part of it.
 */

import { serviceRouting } from '@forge/contracts/criterion-probes';
import { type SignInBody, shown } from '../integrations/deploy/index.js';
import type { JudgedDeployment } from './testing-secret-values.js';

/** The fields an account may be named by, each also the field its sign-in route reads. judge-login
 * reads the same list (`session.rs`: `ACCOUNT_FIELDS`), held equal by `actor-sign-in.test.ts`. */
export const ACCOUNT_FIELDS = ['email', 'username', 'login', 'identifier'] as const;

/** The list as a refusal names it: `email`, `username`, `login` or `identifier`. */
const FIELDS_SAID = `${ACCOUNT_FIELDS.slice(0, -1)
  .map((f) => `\`${f}\``)
  .join(', ')} or \`${ACCOUNT_FIELDS[ACCOUNT_FIELDS.length - 1]}\``;

/** The keys a secret describes a sign-in with beyond its route (ISS-1141). judge-login reads the
 * same keys (`session.rs`: `SIGN_IN_KEYS`), held equal by `actor-sign-in.test.ts`. */
export const SIGN_IN_KEYS = ['loginBody', 'tokenPath'] as const;

/** The whole leaves of a `loginBody` replaced with the secret's account and password. */
export const PLACEHOLDERS = ['$account', '$password'] as const;

/** The merge that describes a GraphQL sign-in, as the refusals naming the door show it. judge-login
 * names the same (`session.rs`: `GRAPHQL_SET`), held equal by `actor-sign-in.test.ts`. */
export const GRAPHQL_SET =
  '{"set":{"loginRoute":"https://<host>/graphql","loginBody":{"query":"mutation Login($email: String!, $password: String!) { login(email: $email, password: $password) { access_token } }","variables":{"email":"$account","password":"$password"}},"tokenPath":"/data/login/access_token"}}';

export interface ActorSecret extends SignInBody {
  field: (typeof ACCOUNT_FIELDS)[number];
  route: { path: string } | { url: URL };
}

/** A segment of a pointer as a refusal may say it: a key or an index, never a value. */
const segmentSaid = (k: string) => shown(k) ?? (/^\d{1,4}$/.test(k) ? k : '…');

/** Each string leaf of `v`, with the pointer to it. */
function leavesOf(v: unknown, at: string[] = []): { at: string[]; leaf: string }[] {
  if (typeof v === 'string') return [{ at, leaf: v }];
  if (v === null || typeof v !== 'object') return [];
  return Object.entries(v).flatMap(([k, inner]) => leavesOf(inner, [...at, k]));
}

/** Why `body` is no `loginBody` a sign-in can send; null where it is one. Names keys, never a value. */
export function loginBodyRefusal(body: unknown): string | null {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return "`loginBody` is a JSON object sent as the sign-in's body, whose string leaves that are exactly `$account` or `$password` become the account and password";
  }
  const leaves = leavesOf(body);
  for (const { at, leaf } of leaves) {
    if (!/^\$[A-Za-z_][A-Za-z0-9_]*$/.test(leaf)) continue;
    if ((PLACEHOLDERS as readonly string[]).includes(leaf)) continue;
    const word = shown(leaf.slice(1)) ? `\`${leaf}\`` : 'a `$`-word';
    return `\`loginBody\` at /${at.map(segmentSaid).join('/')} is ${word}, and a leaf is replaced only when it is exactly \`$account\` or \`$password\``;
  }
  if (!leaves.some((l) => l.leaf === '$password')) {
    return '`loginBody` has no leaf that is exactly `$password`, so the sign-in would send no password';
  }
  return null;
}

/** Why `path` is no `tokenPath`; null where it is a JSON pointer. */
export function tokenPathRefusal(path: unknown): string | null {
  return typeof path === 'string' && /^(\/[^/\s]+)+$/.test(path) && path.length <= 256
    ? null
    : "`tokenPath` is a JSON pointer to the token in the sign-in's answer, such as `/data/login/access_token`";
}

/** Why the secret's `loginBody` or `tokenPath` is unusable; null where neither is named or both are usable. */
function signInKeysRefusal(o: Record<string, unknown>): string | null {
  if (o.loginBody !== undefined) {
    const why = loginBodyRefusal(o.loginBody);
    if (why) return why;
  }
  return o.tokenPath !== undefined ? tokenPathRefusal(o.tokenPath) : null;
}

function keysOf(o: Record<string, unknown>): string {
  const keys = Object.keys(o)
    .map(shown)
    .filter((k): k is string => k !== null)
    .sort();
  return keys.length === 0 ? 'no key judge-login reads' : `keys ${keys.join(', ')}`;
}

const SHAPE = `a JSON object naming \`loginRoute\` (\`<https URL or /path>\`), the account by the field its route reads (${FIELDS_SAID}) and \`password\``;

type OneOf = { why: string } | { one: { key: string; value: string } | null };

function oneOf(o: Record<string, unknown>, keys: readonly string[]): OneOf {
  const found = keys.flatMap((k) => {
    const v = o[k];
    return typeof v === 'string' && v.trim() !== '' ? [{ key: k, value: v.trim() }] : [];
  });
  if (found.length > 1) {
    return { why: `the secret names ${found.map((f) => `\`${f.key}\``).join(' and ')} at once` };
  }
  return { one: found[0] ?? null };
}

/** A URL a password may be sent to: https, or http to this machine only, with no user part. */
function sendable(url: URL, said: string): { url: URL } | { why: string } {
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (!(url.protocol === 'https:' || (url.protocol === 'http:' && loopback))) {
    return {
      why: `${said} is \`${url.protocol}//\`, and a password is sent over https only (http to this machine alone)`,
    };
  }
  if (url.username !== '' || url.password !== '') {
    return { why: `${said} carries a user part; name the account in its own field` };
  }
  return { url };
}

/** Where a secret is stored, so a refusal can name the call that fixes it there. */
export interface SecretAt {
  projectId: string;
  scope: string;
  name: string;
}

/**
 * The call that adds `loginRoute` to a stored secret without anyone reading or retyping its value
 * (ISS-1140); placeholders where the secret's place is not known. judge-login names the same door.
 */
export function loginRouteDoor(at?: SecretAt): string {
  const [id, scope, name] = at ? [at.projectId, at.scope, at.name] : ['<id>', '<scope>', '<name>'];
  const door = `PATCH /api/projects/${id}/secrets/${scope}/${name}`;
  return `${door} {"set":{"loginRoute":"<https URL or /path>"}}; a sign-in that is no \`{<account field>, password}\` POST also sets \`loginBody\` and \`tokenPath\`, a GraphQL one as ${door} ${GRAPHQL_SET}`;
}

/**
 * The secret's sign-in, or why it is no sign-in the probe can make. A `why` names keys and the
 * kind, never a value; `at` lets a missing route name the exact call that adds one.
 */
export function parseActorSecret(
  value: string,
  at?: SecretAt,
): { secret: ActorSecret } | { why: string } {
  let o: unknown;
  try {
    o = JSON.parse(value);
  } catch {
    o = null;
  }
  if (o === null || typeof o !== 'object' || Array.isArray(o)) {
    return {
      why: `the secret is not the self-describing form judge-login signs in with (${SHAPE})`,
    };
  }
  const obj = o as Record<string, unknown>;
  const kindName = shown(obj.kind);
  const kind = kindName ? ` (kind \`${kindName}\`)` : '';
  const password = obj.password;
  if (typeof password !== 'string' || password === '') {
    return {
      why: `the secret${kind} names no \`password\` (it holds ${keysOf(obj)}), so it is the credential itself and no sign-in`,
    };
  }
  const account = oneOf(obj, ACCOUNT_FIELDS);
  if ('why' in account) return account;
  if (!account.one) {
    return {
      why: `the secret${kind} names no account (it holds ${keysOf(obj)}); name it by the field its sign-in route reads: ${FIELDS_SAID}`,
    };
  }
  const route = oneOf(obj, ['loginRoute']);
  if ('why' in route) return route;
  if (!route.one) {
    return {
      why: `the secret${kind} names no sign-in route (it holds ${keysOf(obj)}), and a testing profile declares none, so where to sign in is not known and nothing is guessed; add \`loginRoute\` without retyping the value: ${loginRouteDoor(at)}`,
    };
  }
  const target = routeOf(route.one.value);
  if ('why' in target) return target;
  const keysWhy = signInKeysRefusal(obj);
  if (keysWhy) return { why: `the secret${kind}'s ${keysWhy}` };
  return {
    secret: {
      field: account.one.key as ActorSecret['field'],
      account: account.one.value,
      password,
      route: target,
      ...(obj.loginBody !== undefined && { template: obj.loginBody as Record<string, unknown> }),
      ...(obj.tokenPath !== undefined && { tokenPath: obj.tokenPath as string }),
    },
  };
}

/** Why `route` is no `loginRoute` a sign-in can use, as a secret's own is read; null where it is one. */
export function loginRouteRefusal(route: string): string | null {
  if (route.trim() === '' || route !== route.trim()) {
    return '`loginRoute` is `[POST ]<https URL | /path>`, with no space around it';
  }
  const target = routeOf(route);
  return 'why' in target ? target.why : null;
}

/** The route a secret names: `[POST ]<https URL | /path>`. Another method is refused. */
function routeOf(route: string): ActorSecret['route'] | { why: string } {
  let rest = route;
  const space = route.indexOf(' ');
  if (space > 0 && /^[A-Z]+$/.test(route.slice(0, space))) {
    const method = route.slice(0, space);
    if (method !== 'POST') {
      return { why: `the secret's sign-in route is a \`${method}\`; a sign-in is a POST` };
    }
    rest = route.slice(space + 1).trim();
  }
  if (rest.startsWith('/')) return { path: rest };
  let url: URL;
  try {
    url = new URL(rest);
  } catch {
    return { why: "the secret's sign-in route is neither a URL nor a `/path`" };
  }
  return sendable(url, "the secret's sign-in route");
}

/**
 * The URL to sign in at: the secret's own, or its path on the origin of `deployment` that answers
 * it. A path with no deployment, or an environment whose origins cannot say, is not guessed.
 */
export function signInUrl(
  route: ActorSecret['route'],
  deployment: JudgedDeployment | null,
): { url: URL } | { why: string } {
  if ('url' in route) return { url: route.url };
  const { path } = route;
  if (!deployment) {
    return {
      why: `the secret names the sign-in path \`${path}\`, and no environment names this profile, so which origin answers it is not known`,
    };
  }
  const env = `environment \`${deployment.environment}\``;
  let origin: string | null = deployment.url;
  if (Object.keys(deployment.services).length > 0) {
    if (deployment.routes === null) {
      return {
        why: `${env} declares services and no \`routes\`, so which origin answers \`${path}\` is not known`,
      };
    }
    const owner = serviceRouting(path, deployment.routes);
    if (owner) origin = deployment.services[owner.service] ?? null;
  }
  if (origin === null) return { why: `${env} declares no origin that answers \`${path}\`` };
  let url: URL;
  try {
    url = new URL(path, origin);
  } catch {
    return { why: `\`${path}\` does not join ${env}'s origin` };
  }
  return sendable(url, `${env}'s origin`);
}

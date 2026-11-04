/**
 * One sign-in with a testing profile's actor secret, made by core when the secret is written
 * (ISS-937), so a value that no longer signs in is found at the write and not by a judge's 401.
 *
 * It reads the secret exactly as `forge-runner judge-login` does (ISS-959,
 * `packages/runner/crates/forge-runner/src/cmd/judge_login/session.rs`: `parse_secret`,
 * `sign_in_url`, `sign_in`), so a value that passes here is one judge-login can sign in with:
 * - a JSON object naming `password`; a secret with none (an API key, a token) is the credential
 *   itself and is not probed;
 * - the account under exactly one of `email`, `username` or `login`, sent under that name;
 * - `loginRoute`, `[POST ]<https URL | /path>`: a path signs in at the origin of the judged
 *   deployment that answers it (the service whose longest `routes` prefix claims it, else `url`).
 *
 * The value leaves only as the request body the adapter (`integrations/deploy/sign-in-probe.ts`)
 * sends to that one origin, following no redirect: no answer, refusal, log line or stored row holds
 * it, its account, its length or any part of it.
 */

import { serviceRouting } from '@forge/contracts/criterion-probes';
import { type SignInBody, shown } from '../integrations/deploy/index.js';
import type { JudgedDeployment } from './testing-secret-values.js';

const ACCOUNT_FIELDS = ['email', 'username', 'login'] as const;

export interface ActorSecret extends SignInBody {
  field: (typeof ACCOUNT_FIELDS)[number];
  route: { path: string } | { url: URL };
}

function keysOf(o: Record<string, unknown>): string {
  const keys = Object.keys(o)
    .map(shown)
    .filter((k): k is string => k !== null)
    .sort();
  return keys.length === 0 ? 'no key judge-login reads' : `keys ${keys.join(', ')}`;
}

const SHAPE =
  'a JSON object naming `loginRoute` (`<https URL or /path>`), the account by the field its route reads (`email`, `username` or `login`) and `password`';

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

/**
 * The secret's sign-in, or why it is no sign-in the probe can make. A `why` names keys and the
 * kind, never a value.
 */
export function parseActorSecret(value: string): { secret: ActorSecret } | { why: string } {
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
      why: `the secret${kind} names no account (it holds ${keysOf(obj)}); name it by the field its sign-in route reads: \`email\`, \`username\` or \`login\``,
    };
  }
  const route = oneOf(obj, ['loginRoute']);
  if ('why' in route) return route;
  if (!route.one) {
    return {
      why: `the secret${kind} names no sign-in route (it holds ${keysOf(obj)}), and a testing profile declares none, so where to sign in is not known and nothing is guessed; add \`loginRoute\``,
    };
  }
  const target = routeOf(route.one.value);
  if ('why' in target) return target;
  return {
    secret: {
      field: account.one.key as ActorSecret['field'],
      account: account.one.value,
      password,
      route: target,
    },
  };
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

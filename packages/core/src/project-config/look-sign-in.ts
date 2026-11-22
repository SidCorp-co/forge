/**
 * The session a room agent's look signs its browser box in with (ISS-1386): the actor of the
 * testing profile its environment names, signed in through the path judges use. The value is read
 * from the vault as a judge's read reads it (`testing-secret-values.ts`: `profileRefs`,
 * `decryptedValues`), parsed as `forge-runner judge-login` parses it (`actor-sign-in.ts`), and sent
 * only as the sign-in's body to the one origin it names (`integrations/deploy/sign-in-probe.ts`).
 *
 * What leaves this file is the session the sign-in handed out: its cookies and the `localStorage`
 * entries the secret describes, as judge-login writes them into a Playwright storage state. Every
 * `why` names the actor, a key or a field, never a value, an account or a length.
 */

import { signInAt, tokenIn, valueAt } from '../integrations/deploy/index.js';
import { type ActorSecret, parseActorSecret, signInUrl } from './actor-sign-in.js';
import type { TestingProfile } from './policy-schema.js';
import { readProjectDocument, readTestingProfile } from './service.js';
import { decryptedValues, judgedDeployment, profileRefs } from './testing-secret-values.js';

/** One cookie as a browser is told to hold it, read from a `Set-Cookie` line. */
export interface BrowserCookie {
  name: string;
  value: string;
  /** The page the cookie is set for: the sign-in's origin. */
  url: string;
  domain: string | null;
  path: string;
  httpOnly: boolean;
  secure: boolean;
  sameSite: 'Strict' | 'Lax' | 'None' | null;
}

/** The session a sign-in handed out, as a browser holds it. */
export interface BrowserSession {
  cookies: BrowserCookie[];
  /** The `localStorage` entries the secret describes, and the origin they are written at. */
  storage: { origin: string; items: [string, string][] } | null;
}

/** Who a look signs in as, and the session, or why there is none. */
export type LookSignIn =
  | { kind: 'none' }
  | { kind: 'unknown-actor'; profile: string; asked: string; actors: string[] }
  | { kind: 'actor'; actor: string; session: BrowserSession }
  | { kind: 'unsigned'; actor: string; why: string };

/** The roles a profile's actor may hold, least privileged first. */
const ROLE_ORDER: readonly TestingProfile['actors'][string]['role'][] = [
  'viewer',
  'project-member',
  'org-member',
  'project-admin',
  'org-admin',
  'org-owner',
  'deployment-admin',
];

/** The actor a look signs in as where none is named: the least privileged, then by name. */
export function leastPrivileged(actors: TestingProfile['actors']): string | null {
  const rank = (name: string) => ROLE_ORDER.indexOf(actors[name]?.role ?? 'deployment-admin');
  const names = Object.keys(actors).sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  return names[0] ?? null;
}

/** One `Set-Cookie` line as a browser cookie; null where it deletes the cookie or names none. */
export function cookieOf(line: string, url: URL): BrowserCookie | null {
  const [pair = '', ...attrs] = line.split(';');
  const eq = pair.indexOf('=');
  if (eq <= 0) return null;
  const cookie: BrowserCookie = {
    name: pair.slice(0, eq).trim(),
    value: pair
      .slice(eq + 1)
      .trim()
      .replace(/^"|"$/g, ''),
    url: url.origin,
    domain: null,
    path: '/',
    httpOnly: false,
    secure: false,
    sameSite: null,
  };
  // a delete is Max-Age <= 0, or an Expires already past where no Max-Age overrides it (RFC 6265)
  let maxAge = false;
  let expired = false;
  for (const attr of attrs) {
    const at = attr.indexOf('=');
    const k = (at < 0 ? attr : attr.slice(0, at)).trim().toLowerCase();
    const v = at < 0 ? '' : attr.slice(at + 1).trim();
    if (k === 'max-age') maxAge = true;
    if (k === 'max-age' && Number(v) <= 0) return null;
    if (k === 'expires' && Date.parse(v) <= Date.now()) expired = true;
    if (k === 'domain' && v) cookie.domain = v.replace(/^\./, '').toLowerCase();
    if (k === 'path' && v.startsWith('/')) cookie.path = v;
    if (k === 'httponly') cookie.httpOnly = true;
    if (k === 'secure') cookie.secure = true;
    if (k === 'samesite') {
      const s = v.toLowerCase();
      cookie.sameSite = s === 'strict' ? 'Strict' : s === 'none' ? 'None' : 'Lax';
    }
  }
  return cookie.name && !(expired && !maxAge) ? cookie : null;
}

/**
 * The origin the `localStorage` entries are written at, as judge-login picks it
 * (`judge_login/session/storage.rs`: `origin_for`): the secret's `storageOrigin`; else an absolute
 * route's origin; else the environment's `url`; else the sign-in's own.
 */
function storageOrigin(secret: ActorSecret, envUrl: string | null, at: URL): string {
  if (secret.storageOrigin) return secret.storageOrigin;
  if ('url' in secret.route) return secret.route.url.origin;
  try {
    return envUrl ? new URL(envUrl).origin : at.origin;
  } catch {
    return at.origin;
  }
}

/** The entries `storageKey` and `storage` describe, read from the answer; null where one is empty. */
function storageItems(secret: ActorSecret, body: unknown): [string, string][] | null {
  const items: [string, string][] = [];
  if (secret.storageKey !== undefined) {
    const token = tokenIn(body, secret.tokenPath);
    if (token === null) return null;
    items.push([secret.storageKey, token]);
  }
  for (const [key, pointer] of Object.entries(secret.storage ?? {})) {
    const value = valueAt(body, pointer);
    if (value === undefined || value === null) return null;
    items.push([key, typeof value === 'string' ? value : JSON.stringify(value)]);
  }
  return items;
}

/**
 * Sign in as `asked`, or the profile's least privileged actor, on `environment` of `projectId`.
 * `none` where the environment names no testing profile or its profile declares no actor.
 */
export async function lookSignIn(
  projectId: string,
  environment: string,
  asked: string | undefined,
): Promise<LookSignIn> {
  const document = (await readProjectDocument(projectId))?.document;
  const profileId = document?.environments[environment]?.testing;
  if (!profileId) return { kind: 'none' };
  const profile = (await readTestingProfile(projectId, profileId))?.document;
  const actors = profile?.actors ?? {};
  if (asked !== undefined && !Object.hasOwn(actors, asked)) {
    return { kind: 'unknown-actor', profile: profileId, asked, actors: Object.keys(actors) };
  }
  const actor = asked ?? leastPrivileged(actors);
  if (actor === null) return { kind: 'none' };
  const unsigned = (why: string): LookSignIn => ({ kind: 'unsigned', actor, why });

  const refs = await profileRefs(projectId, profileId, `environment \`${environment}\` names`, {
    actor,
  });
  if (!refs.ok) return unsigned(refs.refusal.message);
  const values = await decryptedValues(projectId, profileId, refs.wanted, environment);
  if (!values.ok) return unsigned(values.refusal.message);
  const value = values.secrets[0]?.value ?? '';
  const parsed = parseActorSecret(value);
  if ('why' in parsed) return unsigned(parsed.why);
  const deployment = judgedDeployment(document, environment);
  const target = signInUrl(parsed.secret.route, deployment);
  if ('why' in target) return unsigned(target.why);
  const signed = await signInAt(parsed.secret, target.url);
  if (!signed.session) {
    const a = signed.answer;
    return unsigned(
      a.answer === 'signs-in'
        ? `the sign-in at ${a.at} gave no session`
        : `the sign-in at ${a.at} ${a.says}`,
    );
  }
  const cookies = signed.session.setCookies
    .map((line) => cookieOf(line, target.url))
    .filter((c): c is BrowserCookie => c !== null);
  const items = storageItems(parsed.secret, signed.session.body);
  if (items === null) {
    return unsigned(
      `the sign-in at ${signed.answer.at} answered no value for a storage key the secret names`,
    );
  }
  if (cookies.length === 0 && items.length === 0) {
    return unsigned(
      `the sign-in at ${signed.answer.at} answered a token and no cookie, and the secret names no \`storageKey\` or \`storage\` a browser keeps it under`,
    );
  }
  const origin = storageOrigin(parsed.secret, deployment?.url ?? null, target.url);
  return {
    kind: 'actor',
    actor,
    session: { cookies, storage: items.length > 0 ? { origin, items } : null },
  };
}

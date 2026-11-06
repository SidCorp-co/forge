/**
 * A project secret written, and the sign-in check a testing profile's actor secret gets on the way
 * in (ISS-937). forge's `secret://dev/qa` drifted from the QA member's password and sat five weeks
 * until a judge's `POST /api/auth/local` answered 401; the write is where that is cheap to see.
 *
 * Refuse or flag, decided by what the environment said:
 * - The environment answered and gave no session (a 4xx, a redirect, a success with no token or
 *   cookie): the write is REFUSED by name, `SECRET_DOES_NOT_SIGN_IN`, naming the profile, actor,
 *   environment, route, status and code. Nothing is written, so a stored value that signs in is
 *   never replaced by one that does not, and the writer learns it at the write.
 * - The environment could not answer (unreachable, timed out, 5xx, 408, 429): the value is
 *   STORED and the actor FLAGGED unusable on its profile with when and why, since refusing would
 *   lose a write made while an environment is down. A later write that signs in clears it.
 * - A shape the probe cannot use (no route, no password, a path no environment's origin answers,
 *   a service's credential) is stored and named on the profile as not probed; nothing is guessed.
 *
 * What is kept is the check alone, in the write's own row of the project's credential audit
 * (`project_variable_events`, act `created`/`updated`, keyed by the ref, `detail.signIn`): never
 * the value, its account, its length or any part of it.
 */

import { secretRefOf } from '@forge/contracts/project-config';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { db, type Tx } from '../db/client.js';
import { projectVariableEvents } from '../db/schema-project-variables.js';
import { type SignInAnswer, trySignIn } from '../integrations/deploy/index.js';
import { encryptSecret, isVaultConfigured } from '../integrations/index.js';
import { parseActorSecret, signInUrl } from './actor-sign-in.js';
import { type ApiRefusal, pointer } from './documents.js';
import type { TestingProfile } from './policy-schema.js';
import { environmentsOf } from './promotion-path.js';
import { listTestingProfiles, readProjectConfig } from './service.js';
import { drizzleConfigStore, type SecretName } from './store.js';
import { judgedDeployment } from './testing-secret-values.js';
import { insertEvents } from './variables-store.js';

const checkSchema = z.object({
  profile: z.string(),
  actor: z.string().optional(),
  service: z.string().optional(),
  environment: z.string().nullable(),
  answer: z.enum(['signs-in', 'refused', 'unconfirmed', 'unprobeable']),
  at: z.string().optional(),
  status: z.number().nullable().optional(),
  code: z.string().nullable().optional(),
  says: z.string(),
});

/** One actor or service of one profile, at one environment, as the write's check found it. */
export type SignInCheck = z.infer<typeof checkSchema>;

const SERVICE_NOT_PROBED =
  "not probed: a service's credential is used as itself, and nothing signs in with it";

/** The sign-in each profile naming `ref` makes with `value`; none where no profile names it. */
async function checksOf(projectId: string, ref: string, value: string): Promise<SignInCheck[]> {
  const profiles = (await listTestingProfiles(projectId)).filter(
    (p) =>
      Object.values(p.document.actors).some((a) => a.credential === ref) ||
      Object.values(p.document.services).some((s) => s.credential === ref),
  );
  if (profiles.length === 0) return [];
  const project = await readProjectConfig(projectId);
  const parsed = parseActorSecret(value);
  const tried = new Map<string, Promise<SignInAnswer>>();
  const checks: SignInCheck[] = [];
  for (const { profileId: profile, document } of profiles) {
    const environments = project
      ? environmentsOf(project.document)
          .filter((e) => e.declaration.testing === profile)
          .map((e) => e.name)
      : [];
    for (const [actor, declared] of Object.entries(document.actors)) {
      if (declared.credential !== ref) continue;
      if ('why' in parsed) {
        checks.push({ profile, actor, environment: null, answer: 'unprobeable', says: parsed.why });
        continue;
      }
      for (const environment of environments.length > 0 ? environments : [null]) {
        const target = signInUrl(
          parsed.secret.route,
          judgedDeployment(project?.document, environment),
        );
        if ('why' in target) {
          checks.push({ profile, actor, environment, answer: 'unprobeable', says: target.why });
          continue;
        }
        // one sign-in per origin and route, however many profiles or environments name it
        const href = target.url.href;
        const pending = tried.get(href) ?? trySignIn(parsed.secret, target.url);
        tried.set(href, pending);
        const answered = await pending;
        checks.push({
          profile,
          actor,
          environment,
          answer: answered.answer,
          at: answered.at,
          status: answered.status,
          code: answered.answer === 'refused' ? answered.code : null,
          says: sayAnswer(answered),
        });
      }
    }
    for (const [service, declared] of Object.entries(document.services)) {
      if (declared.credential !== ref) continue;
      checks.push({
        profile,
        service,
        environment: null,
        answer: 'unprobeable',
        says: SERVICE_NOT_PROBED,
      });
    }
  }
  return checks;
}

function sayAnswer(a: SignInAnswer): string {
  if (a.answer === 'signs-in') return `the sign-in at ${a.at} answered ${a.status} with a session`;
  return `the sign-in at ${a.at} ${a.says}`;
}

function whose(c: SignInCheck): string {
  const who = c.actor !== undefined ? `actor \`${c.actor}\`` : `service \`${c.service}\``;
  const where = c.environment === null ? '' : ` at environment \`${c.environment}\``;
  return `testing profile \`${c.profile}\` ${who}${where}`;
}

export type SecretWriteOutcome =
  | { ok: true; secret: SecretName & { ref: string }; signIn: SignInCheck[] }
  | { ok: false; code: 'VAULT_NOT_CONFIGURED' }
  | { ok: false; refusals: ApiRefusal[] };

/**
 * `PUT /api/projects/:id/secrets/:scope/:name`: the value is tried at every environment whose
 * testing profile names it as an actor's credential, refused where one answers no session, and
 * otherwise stored with its check in the write's audit row (see the module's doc).
 */
export async function writeSecret(input: {
  projectId: string;
  scope: string;
  name: string;
  value: string;
  actor: { id: string; tokenId: string | null; agency: 'human' | 'agent' };
}): Promise<SecretWriteOutcome> {
  if (!isVaultConfigured()) return { ok: false, code: 'VAULT_NOT_CONFIGURED' };
  const { projectId } = input;
  const ref = secretRefOf(input.scope, input.name);
  const signIn = await checksOf(projectId, ref, input.value);
  const refused = signIn.filter((c) => c.answer === 'refused');
  if (refused.length > 0) {
    return {
      ok: false,
      refusals: refused.map((c) => ({
        code: 'SECRET_DOES_NOT_SIGN_IN',
        path: pointer(['testing-profiles', c.profile, 'actors', c.actor ?? '']),
        detail: `${whose(c)} does not sign in with this value: ${c.says}. Nothing was written, and the value ${ref} held before is kept; write the value that signs in there.`,
      })),
    };
  }
  const row = await db.transaction(async (tx) => {
    const stored = await drizzleConfigStore.putSecret(tx, {
      projectId,
      scope: input.scope,
      name: input.name,
      valueEnc: encryptSecret(input.value),
    });
    await insertEvents(tx, [
      {
        projectId,
        variableId: null,
        act: stored.created ? 'created' : 'updated',
        key: ref,
        environment: null,
        actorId: input.actor.id,
        actorTokenId: input.actor.tokenId,
        agency: input.actor.agency,
        detail: { secret: true, signIn },
      },
    ]);
    return stored;
  });
  return {
    ok: true,
    secret: { scope: row.scope, name: row.name, updatedAt: row.updatedAt, ref },
    signIn,
  };
}

/**
 * A secret core itself rewrites, inside the caller's transaction, its audit row naming no person
 * (ISS-1047: the owner's OAuth credential, rotated by a refresh or ended by a refused one). No
 * sign-in check runs: only a scope no testing profile names is written here, and `why` says what
 * core did, never a value.
 */
export async function rewriteSecretAsCore(
  tx: Tx,
  input: { projectId: string; scope: string; name: string; value: string; why: string },
): Promise<{ updatedAt: Date }> {
  const stored = await drizzleConfigStore.putSecret(tx, {
    projectId: input.projectId,
    scope: input.scope,
    name: input.name,
    valueEnc: encryptSecret(input.value),
  });
  await insertEvents(tx, [
    {
      projectId: input.projectId,
      variableId: null,
      act: stored.created ? 'created' : 'updated',
      key: secretRefOf(input.scope, input.name),
      environment: null,
      actorId: null,
      actorTokenId: null,
      agency: null,
      detail: { secret: true, by: 'core', why: input.why },
    },
  ]);
  return { updatedAt: stored.updatedAt };
}

/** Whether an actor's stored secret signs in, as the last write of it was checked. */
export interface ActorStanding {
  credential: string;
  /** true: it signed in at every environment tried; false: it cannot be used; null: not known. */
  usable: boolean | null;
  /** When the value checked was written; null where none is recorded. */
  checkedAt: string | null;
  says: string;
  checks: SignInCheck[];
}

export interface ProfileStanding {
  actors: Record<string, ActorStanding>;
  services: Record<string, { credential: string; usable: null; says: string }>;
}

/** The latest write of each ref, with its stored check: one read for every profile shown. */
async function lastWrites(projectId: string, refs: string[]) {
  if (refs.length === 0) return new Map<string, { at: Date; detail: Record<string, unknown> }>();
  const rows = await db
    .select({
      key: projectVariableEvents.key,
      at: projectVariableEvents.at,
      detail: projectVariableEvents.detail,
    })
    .from(projectVariableEvents)
    .where(
      and(
        eq(projectVariableEvents.projectId, projectId),
        inArray(projectVariableEvents.key, refs),
        inArray(projectVariableEvents.act, ['created', 'updated']),
      ),
    )
    .orderBy(desc(projectVariableEvents.at), desc(projectVariableEvents.id));
  const last = new Map<string, { at: Date; detail: Record<string, unknown> }>();
  for (const r of rows) if (!last.has(r.key)) last.set(r.key, { at: r.at, detail: r.detail });
  return last;
}

function standingOf(
  profile: string,
  actor: string,
  ref: string,
  write: { at: Date; detail: Record<string, unknown> } | undefined,
): ActorStanding {
  // a profile names only a stored secret, and a named one is never deleted, so a value is held
  const base = { credential: ref, checkedAt: write?.at.toISOString() ?? null, checks: [] };
  if (!write) {
    return {
      ...base,
      usable: null,
      says: `no sign-in check is recorded for the value stored at ${ref}; write it again to check it`,
    };
  }
  const recorded = z.array(checkSchema).safeParse(write.detail.signIn ?? []);
  if (!recorded.success) {
    return {
      ...base,
      usable: null,
      says: `the check recorded with the write of ${ref} does not read as a sign-in check; write it again to check it`,
    };
  }
  const checks = recorded.data.filter((c) => c.profile === profile && c.actor === actor);
  const at = base.checkedAt;
  if (checks.length === 0) {
    return {
      ...base,
      usable: null,
      says: `${ref} was written at ${at}, when testing profile \`${profile}\` did not name it as actor \`${actor}\`'s credential, so no check of it is recorded; write it again to check it`,
    };
  }
  const failed = checks.filter((c) => c.answer === 'unconfirmed' || c.answer === 'refused');
  if (failed.length > 0) {
    return {
      ...base,
      checks,
      usable: false,
      says: `unusable: the check at ${at} found no sign-in — ${failed.map((c) => `${whose(c)}: ${c.says}`).join('; ')}. Write the value again once it signs in`,
    };
  }
  const unprobed = checks.filter((c) => c.answer === 'unprobeable');
  if (unprobed.length > 0) {
    return {
      ...base,
      checks,
      usable: null,
      says: `not probed at ${at}: ${unprobed.map((c) => c.says).join('; ')}`,
    };
  }
  return {
    ...base,
    checks,
    usable: true,
    says: `signed in at ${at}: ${checks.map((c) => c.says).join('; ')}`,
  };
}

/** Each listed profile's actors and services, with whether their stored secrets sign in. */
export async function signInStandings(
  projectId: string,
  profiles: { profileId: string; document: TestingProfile }[],
): Promise<Map<string, ProfileStanding>> {
  const refs = [
    ...new Set(profiles.flatMap((p) => Object.values(p.document.actors).map((a) => a.credential))),
  ];
  const writes = await lastWrites(projectId, refs);
  const out = new Map<string, ProfileStanding>();
  for (const { profileId, document } of profiles) {
    const actors: ProfileStanding['actors'] = {};
    for (const [actor, { credential }] of Object.entries(document.actors)) {
      actors[actor] = standingOf(profileId, actor, credential, writes.get(credential));
    }
    const services: ProfileStanding['services'] = {};
    for (const [service, { credential }] of Object.entries(document.services)) {
      services[service] = { credential, usable: null, says: SERVICE_NOT_PROBED };
    }
    out.set(profileId, { actors, services });
  }
  return out;
}

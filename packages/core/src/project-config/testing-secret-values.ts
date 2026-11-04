// The halves of a testing-secrets read every judge shares (`testing-secrets.ts`, `review-run-secrets.ts`):
// the refusal shape, the one ref a read names, and the value decrypted from the project's vault.

import type { TestingSecretsRefusalCode } from '@forge/contracts/project-config';
import { parseVariableRef } from '@forge/contracts/variables';
import { SCRUB_MIN_SECRET_LENGTH } from '@forge/observability';
import { decryptSecret, isVaultConfigured } from '../integrations/index.js';
import type { TestingProfile } from './policy-schema.js';
import type { projectConfigPorts } from './ports.js';
import type { ProjectDocument } from './schema.js';
import { credentialRefs, readTestingProfile } from './service.js';
import { drizzleConfigStore } from './store.js';
import { effectiveVariables } from './variables-rules.js';
import { declaredEnvironments } from './variables-service.js';
import { listVariables, valuesOf } from './variables-store.js';

export interface TestingSecretsRefusal {
  status: 403 | 404 | 409 | 422 | 503;
  code: TestingSecretsRefusalCode;
  message: string;
  details?: Record<string, unknown>;
}

interface ResolvedTestingSecrets {
  /** The job whose credential read them; null where a run a master declared did. */
  jobId: string | null;
  /** The declared run that read them, by core's session and run ids. */
  run?: { session: string; id: string };
  /** The environment judged; null for a review run whose profile no one environment names. */
  environment: string | null;
  profileId: string;
  secrets: { ref: string; value: string }[];
  /** The origins of the environment judged; null where no one environment is. */
  deployment: JudgedDeployment | null;
}

/**
 * The origins of the environment a run judges, as the project document declares them: its `url`,
 * its `services`, and the `routes` naming the path prefixes each service answers (ISS-470).
 * `forge-runner judge-login` signs in at the origin answering the sign-in path its secret names, so
 * the password goes to the deployment judged and the judge holds only the session (ISS-959).
 */
export interface JudgedDeployment {
  environment: string;
  url: string | null;
  services: Record<string, string>;
  routes: Record<string, string[]> | null;
}

/** {@link JudgedDeployment} of `environment` in `document`; null where either is absent. */
export function judgedDeployment(
  document: ProjectDocument | null | undefined,
  environment: string | null,
): JudgedDeployment | null {
  const declared = environment === null ? undefined : document?.environments[environment];
  if (!declared || environment === null) return null;
  return {
    environment,
    url: declared.url ?? null,
    services: declared.services ?? {},
    routes: declared.routes ?? null,
  };
}

export type Refused = { ok: false; refusal: TestingSecretsRefusal };

export type TestingSecretsOutcome = { ok: true; resolved: ResolvedTestingSecrets } | Refused;

export const refuse = (
  status: TestingSecretsRefusal['status'],
  code: TestingSecretsRefusalCode,
  message: string,
  details?: Record<string, unknown>,
): Refused => ({
  ok: false,
  refusal: { status, code, message, ...(details ? { details } : {}) },
});

export type DeclaredRun = Extract<
  Awaited<ReturnType<ReturnType<typeof projectConfigPorts>['declaredRunOfCall']>>,
  { kind: 'run' }
>;

/**
 * The one secret a read names (ISS-868, FB-464): an actor or a service of the profile by its name,
 * or one ref the profile names. A read names exactly one; a run is never handed the whole profile.
 */
export type SecretChoice = { actor: string } | { service: string } | { ref: string };

/** The names a profile declares, as a refusal lists them: never a value. */
function namesOf(profile: TestingProfile) {
  return { actors: Object.keys(profile.actors), services: Object.keys(profile.services) };
}

function listed(names: { actors: string[]; services: string[] }): string {
  const say = (kind: string, all: string[]) =>
    all.length > 0 ? `${kind} ${all.join(', ')}` : `no ${kind}`;
  return `${say('actors', names.actors)}; ${say('services', names.services)}`;
}

/** The secret ref the read names, held to the profile: one ref, or the refusal naming the valid names. */
export async function profileRefs(
  projectId: string,
  profileId: string,
  /** Who named the profile, as the refusal of a profile gone says it: an environment, or a review run. */
  namedBy: string,
  asked: SecretChoice | null,
): Promise<Refused | { ok: true; wanted: string[] }> {
  const held = await readTestingProfile(projectId, profileId);
  if (!held) {
    return refuse(
      422,
      'TESTING_PROFILE_NOT_DECLARED',
      `${namedBy} testing profile \`${profileId}\`, and this project holds no profile of that id.`,
    );
  }
  const profile = held.document;
  const names = namesOf(profile);
  if (asked === null) {
    return refuse(
      422,
      'TESTING_SECRET_UNCHOSEN',
      `a read names the one secret the run needs: ?actor=<name>, ?service=<name> or ?ref=<secret ref>. Testing profile \`${profileId}\` declares ${listed(names)}. Nothing was read.`,
      names,
    );
  }
  let ref: string | undefined;
  let said: string;
  if ('actor' in asked) {
    ref = Object.hasOwn(profile.actors, asked.actor)
      ? profile.actors[asked.actor]?.credential
      : undefined;
    said = `actor \`${asked.actor}\``;
  } else if ('service' in asked) {
    ref = Object.hasOwn(profile.services, asked.service)
      ? profile.services[asked.service]?.credential
      : undefined;
    said = `service \`${asked.service}\``;
  } else {
    ref = credentialRefs(profile).some((r) => r.ref === asked.ref) ? asked.ref : undefined;
    said = asked.ref;
  }
  if (ref === undefined) {
    return refuse(
      422,
      'SECRET_NOT_NAMED',
      `testing profile \`${profileId}\` names no ${said}; it declares ${listed(names)}. Nothing was read.`,
      { asked, ...names },
    );
  }
  const wanted = [ref];
  if (!isVaultConfigured()) {
    return refuse(
      503,
      'VAULT_NOT_CONFIGURED',
      'INTEGRATION_MASTER_KEY is not set on this core, so no secret can be decrypted; nothing was read.',
    );
  }

  return { ok: true, wanted };
}

/**
 * Each wanted value decrypted, long enough for the scrubber to replace in a log. A `var://KEY` ref
 * is the variable effective on `environment`, the one judged, read from the same store (REQ-80 BC-7).
 */
export async function decryptedValues(
  projectId: string,
  profileId: string,
  wanted: string[],
  environment: string | null,
): Promise<Refused | { ok: true; secrets: { ref: string; value: string }[] }> {
  const variables = await variableValues(projectId, wanted, environment);
  if (!variables.ok) return variables;
  const stored = await drizzleConfigStore.secretValues(projectId, wanted);
  for (const [ref, enc] of variables.stored) stored.set(ref, enc);
  const missing = wanted.filter((r) => !stored.has(r));
  if (missing.length > 0) {
    return refuse(
      422,
      'SECRET_VALUE_MISSING',
      `testing profile \`${profileId}\` names ${missing.join(', ')}, and this project stores no value for it; PUT /api/projects/${projectId}/secrets/<scope>/<name> first.`,
      { missing },
    );
  }

  const secrets: { ref: string; value: string }[] = [];
  for (const ref of wanted) {
    let value: string;
    try {
      value = decryptSecret(stored.get(ref) as Buffer);
    } catch (err) {
      return refuse(
        422,
        'SECRET_VALUE_UNREADABLE',
        `${ref} is stored but does not decrypt under this core's INTEGRATION_MASTER_KEY (${err instanceof Error ? err.message : String(err)}); write it again.`,
      );
    }
    if (value.length < SCRUB_MIN_SECRET_LENGTH) {
      return refuse(
        422,
        'SECRET_TOO_SHORT_TO_SCRUB',
        `${ref} holds a value shorter than ${SCRUB_MIN_SECRET_LENGTH} characters, which the secret scrubber does not replace, so it would reach this job's log in plain text; store a longer one.`,
      );
    }
    secrets.push({ ref, value });
  }

  return { ok: true, secrets };
}

/** The encrypted values behind the `var://` refs among `wanted`, on the environment judged. */
async function variableValues(
  projectId: string,
  wanted: readonly string[],
  environment: string | null,
): Promise<Refused | { ok: true; stored: Map<string, Buffer> }> {
  const asked = wanted.flatMap((ref) => {
    const key = parseVariableRef(ref);
    return key === null ? [] : [{ ref, key }];
  });
  if (asked.length === 0) return { ok: true, stored: new Map() };
  const declared = (await declaredEnvironments(projectId)).find((e) => e.name === environment);
  if (!declared) {
    return refuse(
      422,
      'VARIABLE_REF_UNRESOLVED',
      `${asked.map((a) => a.ref).join(', ')} name stored variables, and this read judges no one environment of the project, so which scope applies cannot be named; nothing was read.`,
    );
  }
  // the environment judged is the one the run's landed work deploys to, so a protected variable
  // reaches it exactly where that environment is production-tier (REQ-80 BC-2)
  const { effective, withheld } = effectiveVariables(
    await listVariables(projectId),
    declared,
    true,
  );
  const unresolved = asked.filter((a) => !effective.has(a.key));
  if (unresolved.length > 0) {
    return refuse(
      422,
      'VARIABLE_REF_UNRESOLVED',
      `${unresolved.map((a) => (withheld.includes(a.key) ? `${a.ref} (protected, and \`${declared.name}\` is ${declared.tier}-tier)` : a.ref)).join(', ')} name no variable effective on environment \`${declared.name}\`; nothing was read.`,
      { unresolved: unresolved.map((a) => a.key), environment: declared.name },
    );
  }
  const rows = asked.map((a) => ({
    ref: a.ref,
    row: effective.get(a.key) as NonNullable<ReturnType<typeof effective.get>>,
  }));
  const values = await valuesOf(
    projectId,
    rows.map((r) => r.row.secretName),
  );
  const stored = new Map<string, Buffer>();
  for (const { ref, row } of rows) {
    const enc = values.get(row.secretName);
    if (enc) stored.set(ref, enc);
  }
  return { ok: true, stored };
}

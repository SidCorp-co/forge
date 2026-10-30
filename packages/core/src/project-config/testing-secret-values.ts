// The halves of a testing-secrets read every judge shares (`testing-secrets.ts`, `review-run-secrets.ts`):
// the refusal shape, the profile's refs, and the values decrypted from the project's vault.

import type { TestingSecretsRefusalCode } from '@forge/contracts/project-config';
import { SCRUB_MIN_SECRET_LENGTH } from '@forge/observability';
import { decryptSecret, isVaultConfigured } from '../integrations/index.js';
import type { projectConfigPorts } from './ports.js';
import { credentialRefs, readTestingProfile } from './service.js';
import { drizzleConfigStore } from './store.js';

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

/** The secret refs to resolve: every ref the profile names, or the asked subset of them. */
export async function profileRefs(
  projectId: string,
  profileId: string,
  /** Who named the profile, as the refusal of a profile gone says it: an environment, or a review run. */
  namedBy: string,
  asked: readonly string[] | null,
): Promise<Refused | { ok: true; wanted: string[] }> {
  const profile = await readTestingProfile(projectId, profileId);
  if (!profile) {
    return refuse(
      422,
      'TESTING_PROFILE_NOT_DECLARED',
      `${namedBy} testing profile \`${profileId}\`, and this project holds no profile of that id.`,
    );
  }
  const named = [...new Set(credentialRefs(profile.document).map((r) => r.ref))];
  const wanted = asked === null ? named : [...new Set(asked)];
  const unnamed = wanted.filter((r) => !named.includes(r));
  if (unnamed.length > 0) {
    return refuse(
      422,
      'SECRET_NOT_NAMED',
      `testing profile \`${profileId}\` names none of ${unnamed.join(', ')}; it names ${named.join(', ') || 'no secret'}.`,
      { unnamed },
    );
  }
  if (!isVaultConfigured()) {
    return refuse(
      503,
      'VAULT_NOT_CONFIGURED',
      'INTEGRATION_MASTER_KEY is not set on this core, so no secret can be decrypted; nothing was read.',
    );
  }

  return { ok: true, wanted };
}

/** Each wanted value decrypted, long enough for the scrubber to replace in a log. */
export async function decryptedValues(
  projectId: string,
  profileId: string,
  wanted: string[],
): Promise<Refused | { ok: true; secrets: { ref: string; value: string }[] }> {
  const stored = await drizzleConfigStore.secretValues(projectId, wanted);
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

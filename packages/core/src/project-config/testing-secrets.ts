import type { TestingSecretsRefusalCode } from '@forge/contracts/project-config';
import { JUDGING_JOB_TYPES, SELF_JOB } from '@forge/contracts/project-config';
import { SCRUB_MIN_SECRET_LENGTH } from '@forge/observability';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issues, jobs } from '../db/schema.js';
import { decryptSecret, isVaultConfigured } from '../integrations/index.js';
import type { PatPrincipal } from '../middleware/require-pat.js';
import { projectConfigPorts } from './ports.js';
import { environmentsOf } from './release-path.js';
import type { ProjectDocument } from './schema.js';
import {
  credentialRefs,
  readProjectConfig,
  readSecretValues,
  readTestingProfile,
} from './service.js';

export interface TestingSecretsRefusal {
  status: 403 | 404 | 422 | 503;
  code: TestingSecretsRefusalCode;
  message: string;
  details?: Record<string, unknown>;
}

export interface ResolvedTestingSecrets {
  jobId: string;
  environment: string;
  profileId: string;
  secrets: { ref: string; value: string }[];
}

type Refused = { ok: false; refusal: TestingSecretsRefusal };

export type TestingSecretsOutcome = { ok: true; resolved: ResolvedTestingSecrets } | Refused;

const refuse = (
  status: TestingSecretsRefusal['status'],
  code: TestingSecretsRefusalCode,
  message: string,
  details?: Record<string, unknown>,
): Refused => ({
  ok: false,
  refusal: { status, code, message, ...(details ? { details } : {}) },
});

const JOB_CREDENTIAL_SHAPE =
  'The credential that reaches this route is the one a running job holds: issued to the box the job runs on and bound to the job’s project, so it names exactly one live job.';

// cm:flow testing-secrets/resolve — a job credential reads the values behind the secret:// refs of
// the one testing profile its environment names, and nothing else
export async function resolveTestingSecrets(args: {
  principal: PatPrincipal;
  jobId: string;
  profileId: string;
  refs: readonly string[] | null;
}): Promise<TestingSecretsOutcome> {
  const { principal, profileId } = args;
  const context = await projectConfigPorts().jobOfCredential(principal);
  if (!context.ok) {
    return context.reason === 'ambiguous_pipeline_context'
      ? refuse(422, 'TESTING_SECRETS_JOB_AMBIGUOUS', `${context.detail} Nothing was read.`)
      : refuse(
          403,
          'TESTING_SECRETS_NOT_A_JOB_CREDENTIAL',
          `${context.detail} ${JOB_CREDENTIAL_SHAPE}`,
        );
  }
  if (context.context.jobId === null) {
    return refuse(
      403,
      'TESTING_SECRETS_NOT_A_JOB_CREDENTIAL',
      `This credential's session (${context.context.agentSessionId}) is running no job, so it judges no environment. ${JOB_CREDENTIAL_SHAPE}`,
    );
  }
  const jobId = args.jobId === SELF_JOB ? context.context.jobId : args.jobId;
  if (context.context.jobId !== jobId) {
    return refuse(
      403,
      'TESTING_SECRETS_FOREIGN_JOB',
      `This credential belongs to job ${context.context.jobId}, not job ${jobId}; a job reads only its own testing secrets.`,
      { credentialJobId: context.context.jobId },
    );
  }

  const [job] = await db
    .select({ projectId: jobs.projectId, type: jobs.type, issueId: jobs.issueId })
    .from(jobs)
    .where(eq(jobs.id, jobId))
    .limit(1);
  if (!job) {
    return refuse(403, 'TESTING_SECRETS_FOREIGN_JOB', `job ${jobId} does not exist.`);
  }
  if (!(JUDGING_JOB_TYPES as readonly string[]).includes(job.type)) {
    return refuse(
      422,
      'TESTING_SECRETS_JOB_NOT_JUDGING',
      `job ${jobId} is a \`${job.type}\` job, which judges no deployment; only ${JUDGING_JOB_TYPES.join(', ')} jobs read testing secrets.`,
    );
  }

  const project = await readProjectConfig(job.projectId);
  if (!project) {
    return refuse(
      422,
      'TESTING_SECRETS_NO_PROJECT_DOCUMENT',
      `project ${job.projectId} declares no project document, so no environment names a testing profile.`,
    );
  }
  const judged = await judgedEnvironment(job.issueId, project.document, jobId);
  if (!judged.ok) return judged;
  const { environment, testing } = judged;
  if (testing !== profileId) {
    return refuse(
      422,
      'TESTING_PROFILE_NOT_NAMED',
      `environment \`${environment}\`, which job ${jobId} judges, names testing profile \`${testing}\`, not \`${profileId}\`.`,
    );
  }

  const profile = await readTestingProfile(job.projectId, profileId);
  if (!profile) {
    return refuse(
      422,
      'TESTING_PROFILE_NOT_DECLARED',
      `environment \`${environment}\` names testing profile \`${profileId}\`, and this project holds no profile of that id.`,
    );
  }
  const named = [...new Set(credentialRefs(profile.document).map((r) => r.ref))];
  const wanted = args.refs === null ? named : [...new Set(args.refs)];
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

  const stored = await readSecretValues(job.projectId, wanted);
  const missing = wanted.filter((r) => !stored.has(r));
  if (missing.length > 0) {
    return refuse(
      422,
      'SECRET_VALUE_MISSING',
      `testing profile \`${profileId}\` names ${missing.join(', ')}, and this project stores no value for it; PUT /api/projects/${job.projectId}/secrets/<scope>/<name> first.`,
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

  await projectConfigPorts().recordSecretResolve(jobId, {
    environment,
    profile: profileId,
    refs: wanted,
    tokenId: principal.tokenId,
    deviceId: principal.deviceId ?? null,
  });
  projectConfigPorts().rememberHandedOut(
    jobId,
    secrets.map((s) => s.value),
  );
  return { ok: true, resolved: { jobId, environment, profileId, secrets } };
}

// cm:why the environment a job judges is the one deploying the branch its issue's work landed on —
// the target the merge mark recorded — so no deployment is read and no dispatcher writes a field.
async function judgedEnvironment(
  issueId: string | null,
  document: ProjectDocument,
  jobId: string,
): Promise<Refused | { ok: true; environment: string; testing: string }> {
  const [issue] = issueId
    ? await db
        .select({ mergedAt: issues.mergedAt, target: issues.mergedTarget })
        .from(issues)
        .where(eq(issues.id, issueId))
        .limit(1)
    : [];
  if (!issue) {
    return refuse(
      422,
      'TESTING_SECRETS_NOT_LANDED',
      `job ${jobId} works no issue, so no landed work names the environment it judges.`,
    );
  }
  if (!issue.target) {
    const why = issue.mergedAt
      ? 'its merge mark names no target branch'
      : 'its work has not landed (no merge mark)';
    return refuse(
      422,
      'TESTING_SECRETS_NOT_LANDED',
      `issue ${issueId}: ${why}, so no environment deploying it can be named. Mark it merged with its target first.`,
    );
  }
  const target = issue.target;
  const deploying = environmentsOf(document).filter((e) => e.declaration.deploysFrom === target);
  const [only, ...others] = deploying;
  if (!only) {
    return refuse(
      422,
      'TESTING_SECRETS_NO_ENVIRONMENT_FOR_TARGET',
      `issue ${issueId} landed on \`${target}\`, and no environment of this project deploys from it.`,
      { target },
    );
  }
  if (others.length > 0) {
    return refuse(
      422,
      'TESTING_SECRETS_ENVIRONMENT_AMBIGUOUS',
      `${deploying.length} environments deploy from \`${target}\` (${deploying.map((e) => e.name).join(', ')}), so the one issue ${issueId} is judged on cannot be named.`,
      { target, environments: deploying.map((e) => e.name) },
    );
  }
  if (!only.declaration.testing) {
    return refuse(
      404,
      'TESTING_SECRETS_NO_TESTING_PROFILE',
      `environment \`${only.name}\`, which deploys \`${target}\`, names no testing profile (\`environments.${only.name}.testing\`).`,
    );
  }
  return { ok: true, environment: only.name, testing: only.declaration.testing };
}

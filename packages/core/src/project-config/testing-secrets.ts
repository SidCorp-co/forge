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
import { credentialRefs, readProjectConfig, readTestingProfile } from './service.js';
import { drizzleConfigStore } from './store.js';

interface TestingSecretsRefusal {
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
  environment: string;
  profileId: string;
  secrets: { ref: string; value: string }[];
}

type Refused = { ok: false; refusal: TestingSecretsRefusal };

type TestingSecretsOutcome = { ok: true; resolved: ResolvedTestingSecrets } | Refused;

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
  'The credential that reaches this route is the one a running job holds: issued to the box the job runs on and bound to the job’s project, so it names exactly one live job; or a box’s own credential with the id of a run a master on that box declared (its run id, or core’s session or run id for it) in place of the job id.';

/** The one live job this credential names, which must be the job asked about. */
async function credentialJob(
  principal: PatPrincipal,
  asked: string,
): Promise<Refused | { ok: true; jobId: string }> {
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
  const jobId = asked === SELF_JOB ? context.context.jobId : asked;
  if (context.context.jobId !== jobId) {
    return refuse(
      403,
      'TESTING_SECRETS_FOREIGN_JOB',
      `This credential belongs to job ${context.context.jobId}, not job ${jobId}; a job reads only its own testing secrets.`,
      { credentialJobId: context.context.jobId },
    );
  }

  return { ok: true, jobId };
}

/** The job's row, where it is a judging job. */
async function judgingJob(jobId: string) {
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

  return { ok: true as const, job };
}

/** The secret refs to resolve: every ref the profile names, or the asked subset of them. */
async function profileRefs(
  projectId: string,
  profileId: string,
  environment: string,
  asked: readonly string[] | null,
): Promise<Refused | { ok: true; wanted: string[] }> {
  const profile = await readTestingProfile(projectId, profileId);
  if (!profile) {
    return refuse(
      422,
      'TESTING_PROFILE_NOT_DECLARED',
      `environment \`${environment}\` names testing profile \`${profileId}\`, and this project holds no profile of that id.`,
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
async function decryptedValues(
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

// testing-secrets/resolve — a job credential reads the values behind the secret:// refs of
// the one testing profile its environment names, and nothing else. A run a master declared reads
// them the same way under its box's credential, naming itself (`resolveForDeclaredRun`).
export async function resolveTestingSecrets(args: {
  principal: PatPrincipal;
  jobId: string;
  profileId: string;
  refs: readonly string[] | null;
}): Promise<TestingSecretsOutcome> {
  const { principal, profileId } = args;
  if (args.jobId !== SELF_JOB && principal.deviceId) {
    const declared = await projectConfigPorts().declaredRunOfCall(principal, args.jobId);
    if (declared.kind === 'refused') {
      return refuse(
        403,
        DECLARED_RUN_REFUSAL[declared.reason],
        `${declared.detail} Nothing was read.`,
      );
    }
    if (declared.kind === 'run') return resolveForDeclaredRun({ ...args, run: declared });
  }
  const own = await credentialJob(principal, args.jobId);
  if (!own.ok) return principal.deviceId ? boxCallRefusal(own, args.jobId) : own;
  const { jobId } = own;

  const judging = await judgingJob(jobId);
  if (!judging.ok) return judging;
  const { job } = judging;

  const project = await readProjectConfig(job.projectId);
  if (!project) {
    return refuse(
      422,
      'TESTING_SECRETS_NO_PROJECT_DOCUMENT',
      `project ${job.projectId} declares no project document, so no environment names a testing profile.`,
    );
  }
  const judged = await judgedEnvironment(job.issueId, project.document, `job ${jobId}`);
  if (!judged.ok) return judged;
  const { environment, testing } = judged;
  if (testing !== profileId) {
    return refuse(
      422,
      'TESTING_PROFILE_NOT_NAMED',
      `environment \`${environment}\`, which job ${jobId} judges, names testing profile \`${testing}\`, not \`${profileId}\`.`,
    );
  }

  const refs = await profileRefs(job.projectId, profileId, environment, args.refs);
  if (!refs.ok) return refs;
  const { wanted } = refs;

  const values = await decryptedValues(job.projectId, profileId, wanted);
  if (!values.ok) return values;
  const { secrets } = values;

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

/**
 * What a box's credential that names no job is told. Its `self` is no job, and an id core holds no
 * run of is most often a run declared seconds ago: the box records a declaration at core on its
 * next sweep, not at `forge-runner run declare` (catalog-fe ISS-39, run ff22a502, 2026-10-30, read
 * before that sweep and closed as never started).
 */
function boxCallRefusal(refused: Refused, asked: string): Refused {
  if (refused.refusal.code !== 'TESTING_SECRETS_NOT_A_JOB_CREDENTIAL') return refused;
  if (asked === SELF_JOB) {
    return refuse(
      403,
      'TESTING_SECRETS_NOT_A_JOB_CREDENTIAL',
      `${refused.refusal.message} Under a box's credential \`self\` names no job; call with the declared run's id in place of \`self\`.`,
    );
  }
  return refuse(
    409,
    'TESTING_SECRETS_RUN_NOT_RECORDED',
    `core holds no run this box declared under ${asked}, and this credential runs no job. A run declared moments ago is recorded at core by the box's next sweep, seconds after \`forge-runner run declare\` (the runner log then says \`[run-record] run ${asked} is now core session …\`): read again with the same id once it has, and dispatch the judge after that read. An id that stays unrecorded is no run of this box: a run declared on another box is read under that box's credential. Nothing was read.`,
    { asked },
  );
}

const DECLARED_RUN_REFUSAL = {
  ended: 'TESTING_SECRETS_RUN_ENDED',
  queued: 'TESTING_SECRETS_RUN_NOT_ADMITTED',
  foreign: 'TESTING_SECRETS_FOREIGN_RUN',
} as const satisfies Record<string, TestingSecretsRefusalCode>;

type DeclaredRun = Extract<
  Awaited<ReturnType<ReturnType<typeof projectConfigPorts>['declaredRunOfCall']>>,
  { kind: 'run' }
>;

/**
 * A run a master declared on the caller's box: the runs a master declares execute in its pane under
 * the box's own credential, so the call names the run, and core's record of that run on that box
 * binds the read to its project and the issues it was declared over (adminhub-fe ISS-68's stg
 * judges, 2026-10-27). Its environment is the one deploying the branch an issue of the run landed
 * on, as for a job; the read is audited on that issue and its values scrubbed from what the run's
 * session posts.
 */
async function resolveForDeclaredRun(args: {
  principal: PatPrincipal;
  profileId: string;
  refs: readonly string[] | null;
  run: DeclaredRun;
}): Promise<TestingSecretsOutcome> {
  const { principal, profileId, run } = args;
  const judge = `run ${run.runId}`;
  const project = await readProjectConfig(run.projectId);
  if (!project) {
    return refuse(
      422,
      'TESTING_SECRETS_NO_PROJECT_DOCUMENT',
      `project ${run.projectId} declares no project document, so no environment names a testing profile.`,
    );
  }
  let judged: Awaited<ReturnType<typeof judgedEnvironment>> | null = null;
  let issueId: string | null = null;
  for (const id of run.issueIds) {
    const read = await judgedEnvironment(id, project.document, judge);
    if (read.ok && read.testing === profileId) {
      judged = read;
      issueId = id;
      break;
    }
    if (!judged || (!judged.ok && read.ok)) judged = read;
  }
  if (!judged) {
    return refuse(
      422,
      'TESTING_SECRETS_NOT_LANDED',
      `${judge} was declared over no issue of project ${run.projectId}, so no landed work names the environment it judges.`,
    );
  }
  if (!judged.ok) return judged;
  if (!issueId) {
    return refuse(
      422,
      'TESTING_PROFILE_NOT_NAMED',
      `environment \`${judged.environment}\`, which ${judge} judges, names testing profile \`${judged.testing}\`, not \`${profileId}\`.`,
    );
  }
  const { environment } = judged;

  const refs = await profileRefs(run.projectId, profileId, environment, args.refs);
  if (!refs.ok) return refs;
  const values = await decryptedValues(run.projectId, profileId, refs.wanted);
  if (!values.ok) return values;

  await projectConfigPorts().recordRunSecretResolve({
    issueId,
    sessionId: run.sessionId,
    runId: run.runId,
    deviceId: principal.deviceId ?? '',
    environment,
    profile: profileId,
    refs: refs.wanted,
    tokenId: principal.tokenId,
  });
  projectConfigPorts().rememberHandedOut(
    run.sessionId,
    values.secrets.map((v) => v.value),
  );
  return {
    ok: true,
    resolved: {
      jobId: null,
      run: { session: run.sessionId, id: run.runId },
      environment,
      profileId,
      secrets: values.secrets,
    },
  };
}

// the environment a job judges is the one deploying the branch its issue's work landed on —
// the target the merge mark recorded — so no deployment is read and no dispatcher writes a field.
async function judgedEnvironment(
  issueId: string | null,
  document: ProjectDocument,
  judge: string,
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
      `${judge} works no issue, so no landed work names the environment it judges.`,
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

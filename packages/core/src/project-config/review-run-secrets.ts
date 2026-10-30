import type { PatPrincipal } from '../middleware/require-pat.js';
import { projectConfigPorts } from './ports.js';
import { environmentsOf } from './release-path.js';
import { readProjectConfig } from './service.js';
import {
  type DeclaredRun,
  decryptedValues,
  profileRefs,
  refuse,
  type TestingSecretsOutcome,
} from './testing-secret-values.js';

/**
 * A review run a person declared (`devices/review-run.ts`): its declaration names the one profile it
 * reads, so no landed work is asked to name an environment (a review may read before anything lands,
 * and on a project that deploys nowhere). The person who declared it holds project admin, which is
 * the authority the profile is chosen under. The read is audited on the issue it reviews, naming the
 * declarer, and its values scrubbed from what the run's session posts.
 */
export async function resolveForReviewRun(args: {
  principal: PatPrincipal;
  profileId: string;
  refs: readonly string[] | null;
  run: DeclaredRun;
  review: NonNullable<DeclaredRun['review']>;
}): Promise<TestingSecretsOutcome> {
  const { principal, profileId, run, review } = args;
  const judge = `review run ${run.runId}`;
  if (profileId !== review.profile) {
    return refuse(
      422,
      'TESTING_PROFILE_NOT_NAMED',
      `${judge} was declared to read testing profile \`${review.profile}\`, not \`${profileId}\`; declare a review run naming \`${profileId}\` to read it.`,
    );
  }
  const [issueId] = run.issueIds;
  if (!issueId) {
    return refuse(
      422,
      'TESTING_SECRETS_NOT_LANDED',
      `${judge} names no issue of project ${run.projectId}, so its read has no record to be audited on.`,
    );
  }
  const project = await readProjectConfig(run.projectId);
  const naming = project
    ? environmentsOf(project.document).filter((e) => e.declaration.testing === profileId)
    : [];
  const environment = naming.length === 1 ? (naming[0]?.name ?? null) : null;
  const refs = await profileRefs(
    run.projectId,
    profileId,
    `${judge} was declared to read`,
    args.refs,
  );
  if (!refs.ok) return refs;
  const values = await decryptedValues(run.projectId, profileId, refs.wanted, environment);
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
    declaredBy: review.declaredBy,
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

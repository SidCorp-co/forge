// A judge run declared at a requirement reads its testing secrets (ISS-975). Such a run is declared
// "in place of any issue" (`forge-runner run declare --requirement REQ-n --role qa`, ISS-735), so the
// issue walk that names a run's environment found nothing, and every requirement judge was refused
// TESTING_SECRETS_NOT_LANDED claiming it named no issue (REQ-35 BC-3 and BC-7, run b2bd9ecb).

import { judgedOnOf } from '@forge/contracts/delivery-policy';
import type { PatPrincipal } from '../middleware/require-pat.js';
import { judgedEnvironment } from './judged-environment.js';
import { projectConfigPorts, type RequirementSecretReadAudit } from './ports.js';
import { environmentsOf, productionOf } from './release-path.js';
import type { ProjectDocument } from './schema.js';
import { readProjectConfig } from './service.js';
import {
  type DeclaredRun,
  decryptedValues,
  judgedDeployment,
  profileRefs,
  type Refused,
  refuse,
  type SecretChoice,
  type TestingSecretsOutcome,
} from './testing-secret-values.js';

type Named = {
  ok: true;
  environment: string;
  basis: RequirementSecretReadAudit['basis'];
  issueId: string | null;
};

/**
 * The environment a requirement judge reads for, as the requirement's coverage weighs it: where an
 * issue delivering it has landed, the environment deploying that landing (a landing naming the
 * profile asked for first, as a run over issues picks); where none has, the environment the
 * project's releases are judged on (`delivery.judgedOn`); else production. Refused by name where
 * none can be named, or where the one named does not name the profile asked for.
 */
async function requirementEnvironment(args: {
  judge: string;
  requirement: string;
  issueIds: readonly string[];
  document: ProjectDocument;
  profileId: string;
}): Promise<Refused | Named> {
  const { judge, requirement, document, profileId } = args;
  let landed: Awaited<ReturnType<typeof judgedEnvironment>> | null = null;
  for (const id of args.issueIds) {
    const read = await judgedEnvironment(id, document, judge, profileId);
    // an issue whose work has not landed names no environment; the next one, or the fallback, may
    if (!read.ok && read.refusal.code === 'TESTING_SECRETS_NOT_LANDED') continue;
    if (read.ok && read.testing === profileId) {
      return { ok: true, environment: read.environment, basis: 'landing', issueId: id };
    }
    if (!landed || (!landed.ok && read.ok)) landed = read;
  }
  if (landed && !landed.ok) return landed;
  if (landed?.ok) {
    return refuse(
      422,
      'TESTING_PROFILE_NOT_NAMED',
      `environment \`${landed.environment}\`, which ${judge} judges ${requirement} on (where its delivering issues landed), names testing profile \`${landed.testing}\`, not \`${profileId}\`.`,
    );
  }
  const judgedOn = judgedOnOf(document.delivery);
  const production = productionOf(document)?.name ?? null;
  const name = judgedOn ?? production;
  const basis = judgedOn ? 'judgedOn' : 'production';
  if (!name) {
    const issues =
      args.issueIds.length === 0
        ? `no issue of this project delivers ${requirement}`
        : `none of the ${args.issueIds.length} issues delivering ${requirement} has landed`;
    return refuse(
      422,
      'TESTING_SECRETS_NO_JUDGED_ENVIRONMENT',
      `${judge} judges ${requirement} at the requirement, and no environment it judges can be named: ${issues}, the project names no \`delivery.judgedOn\`, and it declares no production environment. Declare the judge over an issue delivering ${requirement} once its work has landed (\`forge-runner run declare <ISS-n> --role qa\`), or name the environment this project's releases are judged on in \`delivery.judgedOn\`. Nothing was read.`,
    );
  }
  const said = basis === 'judgedOn' ? 'delivery.judgedOn' : 'its production environment';
  const testing = environmentsOf(document).find((e) => e.name === name)?.declaration.testing;
  if (!testing) {
    return refuse(
      404,
      'TESTING_SECRETS_NO_TESTING_PROFILE',
      `environment \`${name}\`, which ${judge} judges ${requirement} on (${said}, no delivering issue having landed), names no testing profile (\`environments.${name}.testing\`).`,
    );
  }
  if (testing !== profileId) {
    return refuse(
      422,
      'TESTING_PROFILE_NOT_NAMED',
      `environment \`${name}\`, which ${judge} judges ${requirement} on (${said}, no delivering issue having landed), names testing profile \`${testing}\`, not \`${profileId}\`.`,
    );
  }
  return { ok: true, environment: name, basis, issueId: null };
}

/**
 * A judge run declared at a requirement: it reads the testing secrets of the environment the
 * requirement is weighed on, and the read is audited on the requirement, naming the run, the box
 * that declared it and the person its credential acts for. Its values are scrubbed from what the
 * run's session posts, as a run over issues' are.
 */
export async function resolveForRequirementRun(args: {
  principal: PatPrincipal;
  profileId: string;
  asked: SecretChoice | null;
  run: DeclaredRun & { requirement: string };
}): Promise<TestingSecretsOutcome> {
  const { principal, profileId, run } = args;
  const judge = `run ${run.boxRunId ?? run.runId}`;
  const subject = await projectConfigPorts().requirementJudgedBy(run.projectId, run.requirement);
  if (!subject) {
    return refuse(
      422,
      'TESTING_SECRETS_NO_JUDGED_ENVIRONMENT',
      `${judge} was declared at ${run.requirement}, which project ${run.projectId} no longer holds, so no environment it judges can be named. Declare the judge over the requirement or issue it judges now. Nothing was read.`,
    );
  }
  const project = await readProjectConfig(run.projectId);
  if (!project) {
    return refuse(
      422,
      'TESTING_SECRETS_NO_PROJECT_DOCUMENT',
      `project ${run.projectId} declares no project document, so no environment names a testing profile.`,
    );
  }
  const named = await requirementEnvironment({
    judge,
    requirement: run.requirement,
    issueIds: subject.issueIds,
    document: project.document,
    profileId,
  });
  if (!named.ok) return named;
  const { environment } = named;

  const refs = await profileRefs(
    run.projectId,
    profileId,
    `environment \`${environment}\` names`,
    args.asked,
  );
  if (!refs.ok) return refs;
  const values = await decryptedValues(run.projectId, profileId, refs.wanted, environment);
  if (!values.ok) return values;

  await projectConfigPorts().recordRequirementSecretRead({
    requirementId: subject.requirementId,
    sessionId: run.sessionId,
    runId: run.runId,
    boxRunId: run.boxRunId,
    deviceId: principal.deviceId ?? '',
    declaredBy: principal.userId,
    issueId: named.issueId,
    basis: named.basis,
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
      deployment: judgedDeployment(project.document, environment),
    },
  };
}

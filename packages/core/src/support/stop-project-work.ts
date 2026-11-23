// The coordination under the owner's archive act (ISS-1449): refuse a project whose release is in
// flight, then stop what the project is running, withdraw what it asked and switch off what it is
// bound to, in that order, so a refusal leaves the project as it was. It owns the sequence; each
// step is another module's own service with its own transaction, so the whole is not one: a
// failure part way leaves the project unarchived and the act can be made again.
//
// It reads no repository and calls no deploy target. A deploy binding is switched off as a row
// (`project-config/bindings.ts:unbindForArchive`), never torn down.

import { stopProjectJobs } from '../jobs/index.js';
import { liveRunsOfProject, stopProjectRuns } from '../pipeline/index.js';
import { unbindForArchive } from '../project-config/index.js';
import { voidProjectQuestions } from '../questions/index.js';
import { pendingConfirmBindingsOf } from '../release-batch/index.js';
import type { OpsOutcome } from './ops-types.js';
import { no } from './outcome.js';

/** Why the questions are withdrawn: read by whoever asked each one. */
const WITHDRAWN_FOR = 'the project was archived at its owner’s word in a room';

/** What was stopped, for the act's answer. */
export type StoppedWork = {
  runs: number;
  jobs: number;
  questionsVoided: number;
  questionsKept: { code: string }[];
  groups: number;
  deploys: number;
};

/** Refuse a live release, then stop the project's work. */
export async function stopProjectWork(at: {
  projectId: string;
  projectSlug: string;
  userId: string;
}): Promise<OpsOutcome<StoppedWork>> {
  const live = await liveRunsOfProject(at.projectId);
  const awaiting = live.filter((r) => pendingConfirmBindingsOf(r.metadata).size > 0);
  if (awaiting.length > 0) {
    return no(
      'SUPPORT_ARCHIVE_DEPLOY_AWAITING_CONFIRM',
      '/project',
      `release ${awaiting.map((r) => r.releaseVersion ?? r.id).join(', ')} holds a production deploy waiting on a confirm: confirm it (release.confirmDeploy) or abort the release first, then archive. Nothing was done`,
    );
  }
  const releasing = live.filter((r) => r.releaseVersion !== null);
  if (releasing.length > 0) {
    return no(
      'SUPPORT_ARCHIVE_RELEASE_IN_FLIGHT',
      '/project',
      `release ${releasing.map((r) => r.releaseVersion).join(', ')} is still running: let it finish or abort it first, then archive. Nothing was done`,
    );
  }

  const by = { userId: at.userId, agency: 'human' as const };
  const runs = await stopProjectRuns({ projectId: at.projectId, ...by });
  const jobs = await stopProjectJobs({ projectId: at.projectId, ...by, reason: WITHDRAWN_FOR });
  const questions = await voidProjectQuestions({
    projectId: at.projectId,
    ...by,
    reason: WITHDRAWN_FOR,
  });
  const unbound = await unbindForArchive(
    at.projectId,
    (b) => b.provider === 'rocketchat' || b.role === 'deploy',
  );
  if (!unbound.ok) {
    return {
      ok: false,
      refusals: unbound.refusals.map((r) => ({
        ...r,
        detail: `${r.detail}. Runs, jobs and questions were stopped, the project is not archived; make the act again once this is fixed`,
      })),
    };
  }
  return {
    ok: true,
    value: {
      runs: runs.length,
      jobs: jobs.length,
      questionsVoided: questions.voided.length,
      questionsKept: questions.kept,
      groups: unbound.unbound.filter((b) => b.provider === 'rocketchat').length,
      deploys: unbound.unbound.filter((b) => b.role === 'deploy').length,
    },
  };
}

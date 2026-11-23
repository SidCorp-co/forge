// The owner's ruling to remove a project, made from his room (ISS-1449, FB-848): the HOP project's
// owner ruled it removed in chat, owner_forge_act had no act for it, and a master may not write
// another project's config on a relayed message, so he had to do it on a page. Who asked is the chat
// server's record of his message (`owner-forge-act.ts:ownerOfMessage`); his own account must be an
// admin of the project's organization, as `POST /api/projects/:id/archive` asks.
//
// What it does, in this order, so a refusal leaves the project as it was: it refuses a project with
// a live release run or a production deploy waiting on a confirm, naming which; it stops the
// project's runs and jobs through their own cancels, withdraws its open questions through the
// question door, switches off its chat groups and deploy bindings, and archives it through the
// archive route's own service (`projects/service.ts:archiveProject`), which also retires its master.
// Each of those is a service with its own transaction, so the whole is not one: a failure part way
// leaves the project unarchived and the act can be made again.
//
// What it never does: it reads no repository and calls no deploy target. A deploy binding is switched
// off as a row (`project-config/bindings.ts:unbindForArchive`), never torn down: no deploy, no
// teardown, no webhook. It deletes no row; the archive is undone with `POST /:id/unarchive`.

import type { SupportForgeActRequest } from '@forge/contracts/support-channel';
import { stopProjectJobs } from '../jobs/index.js';
import { actorFor, orgResource, requireOrgCan } from '../permissions/index.js';
import { liveRunsOfProject, stopProjectRuns } from '../pipeline/index.js';
import { unbindForArchive } from '../project-config/index.js';
import { archiveProject, projectArchiveHead } from '../projects/index.js';
import { voidProjectQuestions } from '../questions/index.js';
import { pendingConfirmBindingsOf } from '../release-batch/index.js';
import type { OpsOutcome } from './ops-types.js';
import { no } from './outcome.js';

/** Why the questions are withdrawn: read by whoever asked each one. */
const WITHDRAWN_FOR = 'the project was archived at its owner’s word in a room';

/** Archive project `at.projectId` as `at.userId`, saying what was done and what was left. */
export async function archiveProjectAsOwner(
  input: SupportForgeActRequest,
  at: { projectId: string; projectSlug: string; userId: string },
): Promise<OpsOutcome<{ key: string; recorded: string }>> {
  if (input.item !== at.projectSlug) {
    return no(
      'SUPPORT_FORGE_ACT_SHAPE',
      '/item',
      `project.archive takes the project's own slug as item (${at.projectSlug}), and ${input.item} is not it: a project is archived by naming it twice, so one named by mistake is never archived. Nothing was done`,
    );
  }
  const head = await projectArchiveHead(at.projectId);
  if (!head) {
    return no(
      'SUPPORT_FORGE_ACT_SHAPE',
      '/project',
      `project ${at.projectSlug} is gone. Nothing was done`,
    );
  }
  // the archive route's own gate: an admin of the project's organization, never a project admin alone
  await requireOrgCan(actorFor(at.userId), 'org.admin', orgResource(head.orgId));
  if (head.archivedAt) {
    return no(
      'SUPPORT_ARCHIVE_ALREADY',
      '/project',
      `${at.projectSlug} was archived on ${head.archivedAt.toISOString()}. Nothing was done; it is restored with unarchive on its page`,
    );
  }
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
  const jobs = await stopProjectJobs({
    projectId: at.projectId,
    ...by,
    reason: WITHDRAWN_FOR,
  });
  const questions = await voidProjectQuestions({
    projectId: at.projectId,
    ...by,
    reason: WITHDRAWN_FOR,
  });
  const unbound = await unbindForArchive(at.projectId);
  if (!unbound.ok) {
    return {
      ok: false,
      refusals: unbound.refusals.map((r) => ({
        ...r,
        detail: `${r.detail}. Runs, jobs and questions were stopped, the project is not archived; make the act again once this is fixed`,
      })),
    };
  }
  const archived = await archiveProject(at.projectId);
  if (!archived) {
    return no(
      'SUPPORT_FORGE_ACT_SHAPE',
      '/project',
      `project ${at.projectSlug} vanished while it was archived`,
    );
  }
  const groups = unbound.unbound.filter((b) => b.provider === 'rocketchat').length;
  const deploys = unbound.unbound.filter((b) => b.role === 'deploy').length;
  const kept = questions.kept.length;
  return {
    ok: true,
    value: {
      key: at.projectSlug,
      recorded: `${at.projectSlug} archived: ${runs.length} run(s) and ${jobs.length} job(s) stopped, ${questions.voided.length} question(s) withdrawn, ${groups} group(s) and ${deploys} deploy binding(s) switched off; its master retires with the archive. Left alone: its repository and every deployed site (nothing was deployed or torn down), and ${kept === 0 ? 'no question' : `${kept} question(s) its own door keeps open (${questions.kept.map((q) => q.code).join(', ')})`}; nothing was deleted, and unarchive restores it`,
    },
  };
}

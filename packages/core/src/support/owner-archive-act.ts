// The owner's ruling to remove a project, made from his room (ISS-1449, FB-848): the HOP project's
// owner ruled it removed in chat, owner_forge_act had no act for it, and a master may not write
// another project's config on a relayed message, so he had to do it on a page. Who asked is the chat
// server's record of his message (`owner-forge-act.ts:ownerOfMessage`); his own account must be an
// admin of the project's organization, as `POST /api/projects/:id/archive` asks.
//
// What it does, in this order, so a refusal leaves the project as it was: the consent and shape
// checks here, then the coordination in `stop-project-work.ts:stopProjectWork` (refuse a live release
// or a deploy waiting on a confirm, stop runs and jobs, withdraw questions, switch off bindings), then
// the archive route's own service (`projects/service.ts:archiveProject`), which also retires its master.
//
// What it never does: it reads no repository and calls no deploy target. A deploy binding is switched
// off as a row (`project-config/bindings.ts:unbindForArchive`), never torn down: no deploy, no
// teardown, no webhook. It deletes no row; the archive is undone with `POST /:id/unarchive`.

import type { SupportForgeActRequest } from '@forge/contracts/support-channel';
import { actorFor, orgResource, requireOrgCan } from '../permissions/index.js';
import { archiveProject, projectArchiveHead } from '../projects/index.js';
import type { OpsOutcome } from './ops-types.js';
import { no } from './outcome.js';
import { stopProjectWork } from './stop-project-work.js';

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
  const stopped = await stopProjectWork(at);
  if (!stopped.ok) return stopped;
  const w = stopped.value;
  const archived = await archiveProject(at.projectId);
  if (!archived) {
    return no(
      'SUPPORT_FORGE_ACT_SHAPE',
      '/project',
      `project ${at.projectSlug} vanished while it was archived`,
    );
  }
  const kept = w.questionsKept.length;
  return {
    ok: true,
    value: {
      key: at.projectSlug,
      recorded: `${at.projectSlug} archived: ${w.runs} run(s) and ${w.jobs} job(s) stopped, ${w.questionsVoided} question(s) withdrawn, ${w.groups} group(s) and ${w.deploys} deploy binding(s) switched off; its master retires with the archive. Left alone: its repository and every deployed site (nothing was deployed or torn down), and ${kept === 0 ? 'no question' : `${kept} question(s) its own door keeps open (${w.questionsKept.map((q) => q.code).join(', ')})`}; nothing was deleted, and unarchive restores it`,
    },
  };
}

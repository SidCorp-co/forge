// The owner's confirm of a production deploy, given in his room (ISS-1441, FB-838): sidpeak 0.32.0's
// owner said "ok" in chat to the deploy its release run had parked on a confirm, and no room act
// could record it, so the run stood waiting on a button press. Who said it is the chat server's
// record of his message (`owner-forge-act.ts:ownerOfMessage`); his own account must hold
// project.admin, the confirm door's permission. The release he names must have a run cut as its
// version with a production deploy parked on a confirm, and each parked deploy is confirmed through
// the page's own door (`release-batch/confirm-prod-door.ts`) as his press, his message cited on the
// gate, so the release run carries on exactly as it does when he presses it. A speaker a project
// declares by chat identity is never lent this: a declaration lends a release's go, not project.admin
// (`release-decide-as.ts:decideAsDeclared`).

import type { SupportForgeActRequest } from '@forge/contracts/support-channel';
import { actorFor, permissionRefusalFor, projectResource } from '../permissions/index.js';
import {
  confirmProdDeployOf,
  NOT_PRODUCTION_BINDING,
  parseReleaseVersion,
  pendingConfirmBindingsOf,
  runCutAs,
} from '../release-batch/index.js';
import type { OpsOutcome } from './ops-types.js';
import { no } from './outcome.js';

/** Confirm, as `at.userId`, every production deploy release `input.item`'s run waits on a confirm for. */
export async function confirmDeployAsOwner(
  input: SupportForgeActRequest,
  cited: { message: string; thread: string; rid: string },
  at: { projectId: string; userId: string },
): Promise<OpsOutcome<{ key: string; recorded: string }>> {
  const refused = await permissionRefusalFor(
    actorFor(at.userId),
    'project.admin',
    projectResource(at.projectId),
    'confirming a production deploy',
  );
  if (refused) {
    return {
      ok: false,
      refusals: [
        {
          code: refused.code,
          path: '/act',
          detail: `${refused.detail}. A production deploy's confirm is a project admin's: nothing was confirmed; tell them one of the project's admins confirms it, here in their own words or on the release's page`,
        },
      ],
    };
  }
  const version = input.item;
  if (!parseReleaseVersion(version)) {
    return no(
      'SUPPORT_RELEASE_VERSION_AMBIGUOUS',
      '/item',
      `${version} names no one release: item is the release's whole version as its page shows it (MAJOR.MINOR.PATCH, e.g. 0.19.0), so read the project's releases and name the one he meant. Nothing was confirmed`,
    );
  }
  const run = await runCutAs(at.projectId, version);
  const waiting = [...pendingConfirmBindingsOf(run?.metadata)];
  if (!run || waiting.length === 0) {
    return no(
      'SUPPORT_CONFIRM_DEPLOY_NOT_WAITING',
      '/item',
      `${run ? `release ${version}'s run holds no production deploy waiting on a confirm: it was confirmed already, or it has not parked for one` : `no release run was cut as ${version}`}, so there is nothing to confirm. Read the release's waitingOn for what it waits on. Nothing was confirmed`,
    );
  }
  const confirmed: string[] = [];
  const resumed: string[] = [];
  for (const bindingId of waiting) {
    const out = await confirmProdDeployOf({ ...at, bindingId, cited });
    if (!out.ok) {
      return no(
        'SUPPORT_CONFIRM_DEPLOY_NOT_PRODUCTION',
        '/item',
        `${out.why === 'not_production' ? NOT_PRODUCTION_BINDING : `binding ${bindingId} is not this project's`}. ${confirmed.length > 0 ? `Confirmed before it: ${confirmed.join(', ')}` : 'Nothing was confirmed'}`,
      );
    }
    if (out.result.confirmed && out.result.runId === run.id) {
      confirmed.push(bindingId);
      if (out.result.resumed) resumed.push(out.result.resumed);
    }
  }
  if (confirmed.length === 0) {
    return no(
      'SUPPORT_CONFIRM_DEPLOY_NOT_WAITING',
      '/item',
      `release ${version}'s production deploy was confirmed on no run of its own: its gate is held by another run. Nothing was confirmed`,
    );
  }
  return {
    ok: true,
    value: {
      key: version,
      recorded: `his confirm of ${version}'s production deploy on ${confirmed.join(', ')}, release run ${run.id} carried on (${resumed.join(', ') || 'no release job to tell'})`,
    },
  };
}

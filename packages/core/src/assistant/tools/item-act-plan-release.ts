// The release adapter of `item-act-plans.ts:planItemAct`: what a release's page offers the asker.

import type { ItemAct } from '@forge/contracts/item-acts';
import { loadProjectAccess } from '../../lib/authz.js';
import { holds } from '../../permissions/index.js';
import { readRelease } from '../../release-batch/index.js';
import { type Asker, found, type ItemActReading, no, offer, unknown } from './item-act-plan-kit.js';

export async function planRelease(act: ItemAct, key: string, at: Asker): Promise<ItemActReading> {
  const access = await loadProjectAccess(at.projectId, at.userId);
  const viewer = {
    userId: at.userId,
    agency: 'human' as const,
    isAdmin: holds(access, 'project.admin'),
    mayApprove: holds(access, 'releases.approve'),
  };
  const r = await found(readRelease(at.projectId, key, viewer));
  if (!r) return unknown('release', key);
  const base = { key: r.version, ref: r.version, title: r.name ?? r.version, from: r.state };
  if (act === 'release.cut') {
    const issues =
      r.can.split && r.split ? r.issues.filter((i) => r.split?.issueIds.includes(i.id)) : r.issues;
    if (!r.can.cut && !r.can.split)
      return no(
        viewer.isAdmin ? 'ITEM_ACT_NOT_FROM_STATE' : 'ITEM_ACT_FORBIDDEN',
        viewer.isAdmin
          ? `${r.version} is ${r.state} and cannot be cut now; its page names what stands in the way.`
          : `the person asking is not a project admin, so cutting ${r.version} is not theirs to press.`,
      );
    return offer({
      ...base,
      issueIds: issues.map((i) => i.id),
      issueKeys: issues.map((i) => i.key),
    });
  }
  if (!r.can.decide || !r.approval || !r.runId)
    return no(
      viewer.mayApprove ? 'ITEM_ACT_NOT_FROM_STATE' : 'ITEM_ACT_FORBIDDEN',
      viewer.mayApprove
        ? `${r.version} is ${r.state}, and ${act} applies to a release awaiting approval.`
        : `the person asking does not hold releases.approve, so deciding ${r.version} is not theirs to press.`,
    );
  return offer({ ...base, runId: r.runId, approvalId: r.approval.id });
}

/**
 * What the page beside the chat shows of a release or of a decision open in the Approvals peek
 * (`page-item.ts:loadPageItem`), each read as the person reads it on that page.
 */

import { effectiveProjectRole } from '../lib/authz.js';
import { holds } from '../permissions/index.js';
import { readRelease } from '../release-batch/index.js';
import { missing, type Shown } from './page-item-shown.js';
import { readDecisions } from './tools/decide-tool.js';

export async function releaseShown(projectId: string, key: string, userId: string): Promise<Shown> {
  const access = await effectiveProjectRole(userId, projectId);
  const viewer = access
    ? {
        userId,
        agency: 'human' as const,
        isAdmin: holds(access, 'project.admin'),
        mayApprove: holds(access, 'releases.approve'),
      }
    : null;
  try {
    const r = await readRelease(projectId, key, viewer);
    return {
      key: r.version,
      meta: {
        state: r.state,
        issueCount: r.issueCount,
        awaitingApproval: r.approval !== null && r.approval.decision === null,
        canCut: r.can.cut,
        canDecide: r.can.decide,
      },
      content: { title: r.name ?? r.version, summary: r.summary },
    };
  } catch (err) {
    return missing(err);
  }
}

/** A decision open in the Approvals peek, as the person's Needs-you read holds it. */
export async function approvalShown(
  projectId: string,
  key: string,
  userId: string,
): Promise<Shown> {
  const d = (await readDecisions(projectId, userId)).find((x) => x.id === key);
  if (!d) return null;
  return {
    key: d.id,
    meta: {
      topic: d.topic,
      decides: d.key,
      opens: d.opens,
      answers: d.answers.map((a) => a.label),
      recommended: d.recommended?.answerId ?? null,
    },
    content: { title: d.title, question: d.question },
  };
}

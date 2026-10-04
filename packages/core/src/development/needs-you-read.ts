import { AUTOMATION_FIRES_DEFAULT } from '@forge/contracts/automation-standing';
import type { NeedsYouResponse } from '@forge/contracts/needs-you';
import { automationViewerOf, readAutomationStanding } from '../automation/read.js';
import { readContractStanding } from '../ecosystem/standing/read.js';
import { listFeedbackAs } from '../feedback/read.js';
import type { ActorAgency } from '../issues/actor-agency.js';
import { listIssueStanding } from '../issues/standing-read.js';
import { listReleases } from '../release-batch/release-read.js';
import { listRequirementsAs } from '../requirements/read.js';
import { areaOf, untriaged } from './needs-you.js';

export interface NeedsYouViewer {
  userId: string;
  agency: ActorAgency;
  isAdmin: boolean;
  /** Holds releases.approve (`lib/approval.ts:mayApprove`). */
  mayApprove: boolean;
}

async function automationOf(projectId: string, userId: string, now: Date) {
  const viewer = await automationViewerOf(projectId, userId);
  if (!viewer)
    throw new Error(
      `needs-you: ${userId} reached the automation count of a project they are not a member of`,
    );
  return readAutomationStanding(projectId, viewer, { firesLimit: AUTOMATION_FIRES_DEFAULT }, now);
}

// cm:guard each count calls the read model its list calls, with the viewer that list's route builds,
// and counts that list's own waiting-on-you group: a second derivation here is how a menu number and
// the list it opens come to disagree (REQ-11 BC-10, BC-12)
export async function readNeedsYou(
  projectId: string,
  viewer: NeedsYouViewer,
  now: Date = new Date(),
): Promise<NeedsYouResponse> {
  const [requirements, feedback, releases, issues, contracts, automation] = await Promise.all([
    listRequirementsAs(viewer, projectId),
    listFeedbackAs(viewer, projectId),
    listReleases(projectId, viewer),
    listIssueStanding(projectId, 'open', { userId: viewer.userId }, now),
    readContractStanding(projectId, viewer.userId, now),
    automationOf(projectId, viewer.userId, now),
  ]);
  if (!feedback.ok) {
    throw new Error(
      `needs-you: the feedback list refused its own unfiltered read (${feedback.refusals.map((r) => r.code).join(', ')})`,
    );
  }
  const items = feedback.list.feedback;
  return {
    generatedAt: now.toISOString(),
    areas: {
      requirements: areaOf(
        requirements,
        (r) => r.standing.attentionGroup === 'needs_you',
        (r) => r.standing.waitingOn.act,
      ),
      releases: areaOf(
        releases.releases,
        (r) => r.attention === 'you',
        (r) => r.waiting.act,
      ),
      feedback: areaOf(
        items,
        (f) => f.attention === 'you',
        (f) => f.waiting.act,
      ),
      issues: areaOf(
        issues.issues,
        (i) => i.standing.attentionGroup === 'needs_you',
        (i) => i.standing.waitingOn.act,
      ),
      contracts: areaOf(
        contracts.contracts,
        (c) => c.attentionGroup === 'needs_you',
        (c) => c.waitingOn.act,
      ),
      automation: areaOf(
        [...automation.schedules, ...automation.reports],
        (r) => r.attentionGroup === 'needs_you',
        (r) => r.waitingOn.act ?? '',
      ),
    },
    requirementsInDelivery: requirements.filter((r) => r.standing.state === 'in_delivery').length,
    untriagedFeedback: items.filter((f) => untriaged(f.phase)).length,
  };
}

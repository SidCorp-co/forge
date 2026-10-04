/**
 * What waits on the viewer in one project, the one needs-you read model: each area calls the read
 * model its list calls, with the viewer that list's route builds, and keeps the rows that model
 * groups `needs_you` (`@forge/contracts/standing:needsViewer`). A second derivation is how a menu
 * count and the list it opens come to disagree (REQ-11 BC-10, BC-12).
 */

import { AUTOMATION_FIRES_DEFAULT } from '@forge/contracts/automation-standing';
import { FEEDBACK_UNTRIAGED_PHASES, type FeedbackPhase } from '@forge/contracts/feedback';
import {
  NEEDS_YOU_AREAS,
  type NeedsYouArea,
  type NeedsYouAreaKey,
  type NeedsYouEntity,
  type NeedsYouItem,
  type NeedsYouProjectItem,
  type NeedsYouResponse,
} from '@forge/contracts/needs-you';
import { inArray } from 'drizzle-orm';
import { needsViewer, type Standing } from '@forge/contracts/standing';
import { automationViewerOf, readAutomationStanding } from '../automation/read.js';
import { readContractStanding } from '../ecosystem/standing/read.js';
import { listFeedbackAs } from '../feedback/read.js';
import type { ActorAgency } from '../issues/actor-agency.js';
import { listIssueStanding } from '../issues/standing-read.js';
import { listReleases } from '../release-batch/release-read.js';
import { db } from '../db/client.js';
import { projects } from '../db/schema.js';
import { effectiveProjectRole, loadVisibleProjectIds, type ProjectAccess } from '../lib/authz.js';
import { holds } from '../permissions/index.js';
import { listRequirementsAs } from '../requirements/read.js';

export interface NeedsYouViewer {
  userId: string;
  agency: ActorAgency;
  isAdmin: boolean;
  /** Holds releases.approve (`permissions/can.ts:holds`). */
  mayApprove: boolean;
}

/** The viewer each list's route builds for this caller, so the counts read as the lists do. */
export const needsYouViewerOf = (
  access: ProjectAccess,
  userId: string,
  agency: ActorAgency,
): NeedsYouViewer => ({
  userId,
  agency,
  isAdmin: holds(access, 'project.admin'),
  mayApprove: holds(access, 'releases.approve'),
});

interface Row {
  entity: NeedsYouEntity;
  key: string;
  title: string;
  standing: Standing;
  touchedAt: string | null;
}

function areaOf(rows: readonly Row[]): NeedsYouArea {
  const tally = new Map<string, number>();
  for (const row of rows) {
    const act = row.standing.waitingOn.act;
    tally.set(act, (tally.get(act) ?? 0) + 1);
  }
  const acts = [...tally]
    .map(([act, count]) => ({ act, count }))
    .sort((a, b) => b.count - a.count || a.act.localeCompare(b.act));
  return { you: rows.length, acts };
}

const UNTRIAGED: ReadonlySet<FeedbackPhase> = new Set(FEEDBACK_UNTRIAGED_PHASES);

async function automationOf(projectId: string, userId: string, now: Date) {
  const viewer = await automationViewerOf(projectId, userId);
  if (!viewer)
    throw new Error(
      `needs-you: ${userId} reached the automation count of a project they are not a member of`,
    );
  return readAutomationStanding(projectId, viewer, { firesLimit: AUTOMATION_FIRES_DEFAULT }, now);
}

const newestFirst = (a: Row, b: Row) => (b.touchedAt ?? '').localeCompare(a.touchedAt ?? '');

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
  const rows: Record<NeedsYouAreaKey, Row[]> = {
    requirements: requirements.map((r) => ({
      entity: 'requirement',
      key: r.key,
      title: r.title,
      standing: r.standing,
      touchedAt: r.standing.touchedAt,
    })),
    releases: releases.releases.map((r) => ({
      entity: 'release',
      key: r.version,
      title: r.headline || `Release ${r.version}`,
      standing: r,
      touchedAt: r.at,
    })),
    feedback: items.map((f) => ({
      entity: 'feedback',
      key: f.key,
      title: f.title,
      standing: f,
      touchedAt: f.updatedAt,
    })),
    issues: issues.issues.map((i) => ({
      entity: 'issue',
      key: i.key,
      title: i.title,
      standing: i.standing,
      touchedAt: i.standing.touchedAt,
    })),
    contracts: contracts.contracts.map((c) => ({
      entity: 'contract',
      key: c.ref,
      title: c.title,
      standing: c,
      touchedAt: c.touchedAt,
    })),
    automation: [
      ...automation.schedules.map(
        (s): Row => ({
          entity: 'schedule',
          key: s.id,
          title: s.name,
          standing: s,
          touchedAt: s.lastFire?.startedAt ?? s.createdAt,
        }),
      ),
      ...automation.reports.map(
        (r): Row => ({
          entity: 'report',
          key: r.id,
          title: r.summary,
          standing: r,
          touchedAt: r.createdAt,
        }),
      ),
    ],
  };
  const owed = Object.fromEntries(
    Object.entries(rows).map(([area, list]) => [
      area,
      list.filter((r) => needsViewer(r.standing)).sort(newestFirst),
    ]),
  ) as Record<NeedsYouAreaKey, Row[]>;
  return {
    generatedAt: now.toISOString(),
    areas: Object.fromEntries(
      Object.entries(owed).map(([area, list]) => [area, areaOf(list)]),
    ) as Record<NeedsYouAreaKey, NeedsYouArea>,
    items: NEEDS_YOU_AREAS.flatMap((area) =>
      owed[area].map(
        (r): NeedsYouItem => ({
          area,
          entity: r.entity,
          key: r.key,
          title: r.title,
          waitingOn: r.standing.waitingOn,
          touchedAt: r.touchedAt,
        }),
      ),
    ),
    requirementsInDelivery: requirements.filter((r) => r.standing.state === 'in_delivery').length,
    untriagedFeedback: items.filter((f) => UNTRIAGED.has(f.phase)).length,
  };
}

/** The same rows across every project the viewer can see, each project read by `readNeedsYou`. */
export async function readNeedsYouAcross(
  userId: string,
  agency: ActorAgency,
  now: Date = new Date(),
): Promise<NeedsYouProjectItem[]> {
  const ids = await loadVisibleProjectIds(userId);
  if (ids.length === 0) return [];
  const names = await db
    .select({ id: projects.id, slug: projects.slug, name: projects.name })
    .from(projects)
    .where(inArray(projects.id, ids));
  const perProject = await Promise.all(
    names.map(async (p) => {
      const access = await effectiveProjectRole(userId, p.id);
      if (!access || !holds(access, 'project.read')) return [];
      const read = await readNeedsYou(p.id, needsYouViewerOf(access, userId, agency), now);
      return read.items.map((i) => ({ ...i, projectSlug: p.slug, projectName: p.name }));
    }),
  );
  return perProject.flat();
}

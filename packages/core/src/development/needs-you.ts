/**
 * What waits on the viewer in one project, the one needs-you read model: each area calls the read
 * model its list calls, with the viewer that list's route builds, and keeps the rows that model
 * groups `needs_you` (`@forge/contracts/standing:needsViewer`). A second derivation is how a menu
 * count and the list it opens come to disagree (REQ-11 BC-10, BC-12).
 */

import { AUTOMATION_FIRES_DEFAULT } from '@forge/contracts/automation-standing';
import type { NeedsYouAreaKey, NeedsYouEntity } from '@forge/contracts/needs-you';
import type { ActorAgency } from '@forge/contracts/permissions';
import { say } from '@forge/contracts/said';
import { needsViewer, type Standing } from '@forge/contracts/standing';
import type { StandingTimes } from '@forge/contracts/steward';
import type { WorkflowHealth } from '@forge/contracts/workflow-health';
import { automationViewerOf, readAutomationStanding } from '../automation/index.js';
import { readContractStanding } from '../ecosystem/standing/read.js';
import { listFeedbackAs } from '../feedback/list-page-read.js';
import { listIssueStanding } from '../issues/standing-read.js';
import { listReleases } from '../release-batch/release-read.js';
import { listRequirementsAs } from '../requirements/read.js';
import { designRowOf, repinRowOf } from './needs-you-design.js';
import { questionRowsOf } from './needs-you-question.js';
import { designHealthOf, designRepinsOf } from './ports.js';
import { composedTitle, type RowTitle, writtenTitle } from './row-title.js';

export interface NeedsYouViewer {
  userId: string;
  agency: ActorAgency;
  isAdmin: boolean;
  /** Holds releases.approve (`permissions/can.ts:holds`). */
  mayApprove: boolean;
  /** Holds project.write: the grant an answer to a question takes. */
  mayWrite: boolean;
}

export interface AttentionRow extends RowTitle {
  entity: NeedsYouEntity;
  key: string;
  standing: Standing;
  touchedAt: string | null;
  /** Whether its item reads stuck and when its act falls due (`StandingTimes`), where its slice says. */
  due?: { stuck: boolean; dueAt: string | null };
}

async function automationOf(projectId: string, userId: string, now: Date) {
  const viewer = await automationViewerOf(projectId, userId);
  if (!viewer)
    throw new Error(
      `needs-you: ${userId} reached the automation count of a project they are not a member of`,
    );
  return readAutomationStanding(projectId, viewer, { firesLimit: AUTOMATION_FIRES_DEFAULT }, now);
}

/**
 * A moved base's pin-only dependents as one row; a pin-only proposal the act would approve is counted
 * in that row and is not a row of its own.
 */
function designRowsOf(
  health: ReadonlyMap<string, WorkflowHealth>,
  repins: Awaited<ReturnType<typeof designRepinsOf>>,
): AttentionRow[] {
  const grouped = new Set(repins.groups.flatMap((g) => g.ready.map((r) => r.flow)));
  return [
    ...repins.groups.map((g) => repinRowOf(g, repins.canDecide)),
    ...[...health.values()]
      .filter((h) => !grouped.has(h.flow))
      .flatMap((h) => designRowOf(h) ?? []),
  ];
}

const dueOf = (t: Pick<StandingTimes, 'stuck' | 'dueAt'>) => ({
  stuck: t.stuck !== null,
  dueAt: t.dueAt,
});

export const newestFirst = (a: AttentionRow, b: AttentionRow) =>
  (b.touchedAt ?? '').localeCompare(a.touchedAt ?? '');

/**
 * Every area's rows with their standing, and the lists they were read from: the one derivation
 * needs-you filters to the viewer and the project status reads whom each row waits on from.
 */
export async function readAttention(
  projectId: string,
  viewer: NeedsYouViewer,
  now: Date = new Date(),
) {
  const [
    requirements,
    feedback,
    releases,
    issues,
    contracts,
    automation,
    health,
    detached,
    repins,
  ] = await Promise.all([
    listRequirementsAs(viewer, projectId),
    listFeedbackAs(viewer, projectId),
    listReleases(projectId, viewer),
    listIssueStanding(projectId, 'open', { userId: viewer.userId }, now),
    readContractStanding(projectId, viewer.userId, now),
    automationOf(projectId, viewer.userId, now),
    designHealthOf(viewer, projectId),
    questionRowsOf(projectId, viewer),
    designRepinsOf(viewer, projectId),
  ]);
  if (!feedback.ok) {
    throw new Error(
      `needs-you: the feedback list refused its own unfiltered read (${feedback.refusals.map((r) => r.code).join(', ')})`,
    );
  }
  const items = feedback.list.feedback;
  const rows: Record<NeedsYouAreaKey, AttentionRow[]> = {
    requirements: requirements.map((r) => ({
      entity: 'requirement',
      key: r.key,
      ...writtenTitle(r.title, null),
      standing: r.standing,
      touchedAt: r.standing.touchedAt,
      due: dueOf(r.standing.times),
    })),
    releases: releases.releases.map((r) => ({
      entity: 'release',
      key: r.version,
      ...(r.name
        ? writtenTitle(r.name, null)
        : composedTitle(say('needsYou.title.release', { version: r.version }))),
      standing: r,
      touchedAt: r.at,
    })),
    feedback: items.map((f) => ({
      entity: 'feedback',
      key: f.key,
      ...writtenTitle(f.title, f.writtenLang),
      standing: f,
      touchedAt: f.updatedAt,
      due: dueOf(f.times),
    })),
    issues: issues.issues.map((i) => ({
      entity: 'issue',
      key: i.key,
      ...writtenTitle(i.title, i.writtenLang),
      standing: i.standing,
      touchedAt: i.standing.touchedAt,
      due: dueOf(i.standing.times),
    })),
    contracts: contracts.contracts.map((c) => ({
      entity: 'contract',
      key: c.ref,
      ...writtenTitle(c.title, null),
      standing: c,
      touchedAt: c.touchedAt,
    })),
    questions: detached,
    designs: designRowsOf(health, repins),
    automation: [
      ...automation.schedules.map(
        (s): AttentionRow => ({
          entity: 'schedule',
          key: s.id,
          ...writtenTitle(s.name, null),
          standing: s,
          touchedAt: s.lastFire?.startedAt ?? s.createdAt,
        }),
      ),
    ],
  };
  return { rows, requirements, releases, issues, feedback: items, health, repins };
}

/** Each area's rows that wait on the viewer, newest first: the one filter every Needs you read takes. */
export function owedOf(
  rows: Record<NeedsYouAreaKey, AttentionRow[]>,
): Record<NeedsYouAreaKey, AttentionRow[]> {
  return Object.fromEntries(
    Object.entries(rows).map(([area, list]) => [
      area,
      list.filter((r) => needsViewer(r.standing)).sort(newestFirst),
    ]),
  ) as Record<NeedsYouAreaKey, AttentionRow[]>;
}

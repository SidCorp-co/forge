/**
 * What waits on the viewer in one project, the one needs-you read model: each area calls the read
 * model its list calls, with the viewer that list's route builds, and keeps the rows that model
 * groups `needs_you` (`@forge/contracts/standing:needsViewer`). A second derivation is how a menu
 * count and the list it opens come to disagree (REQ-11 BC-10, BC-12). No area lists an issue: the
 * agents work issues, and a question one holds reaches a person on its item (REQ-68 BC-6).
 */

import { AUTOMATION_FIRES_DEFAULT } from '@forge/contracts/automation-standing';
import type { NeedsYouAreaKey, NeedsYouEntity } from '@forge/contracts/needs-you';
import type { ActorAgency } from '@forge/contracts/permissions';
import type { ReleaseListResponse } from '@forge/contracts/releases';
import { say } from '@forge/contracts/said';
import { needsViewer, type Standing } from '@forge/contracts/standing';
import type { StandingTimes } from '@forge/contracts/steward';
import type { WorkflowHealth } from '@forge/contracts/workflow-health';
import { automationViewerOf, readAutomationStanding } from '../automation/index.js';
import { readContractStanding } from '../ecosystem/standing/read.js';
import { listFeedbackAs } from '../feedback/list-page-read.js';
import { listIssueStanding } from '../issues/standing-read.js';
import { listReleases, listReleasesInPlay } from '../release-batch/release-read-list.js';
import { listRequirementsAs } from '../requirements/read.js';
import { designRowOf, designSettlerOf, repinRowOf } from './needs-you-design.js';
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
  settleBy: 'person' | 'master',
): AttentionRow[] {
  const grouped = new Set(repins.groups.flatMap((g) => g.ready.map((r) => r.flow)));
  return [
    ...repins.groups.map((g) => repinRowOf(g, repins.canDecide)),
    ...[...health.values()]
      .filter((h) => !grouped.has(h.flow))
      .flatMap((h) => designRowOf(h, settleBy) ?? []),
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
 * needs-you filters to the viewer and the project status reads whom each row waits on from. The
 * project status reads every release (`listReleases`); Needs you only those that can still wait on
 * someone (`readNeedsYouAttention`), and lists the same rows either way.
 */
export function readAttention(projectId: string, viewer: NeedsYouViewer, now: Date = new Date()) {
  return attentionOf(projectId, viewer, now, listReleases(projectId, viewer));
}

/**
 * The attention read Needs you is built from: its releases are those that can still wait on
 * someone (`release-read.ts:listReleasesInPlay`), since a release shipped, failed or aborted is no
 * row any reader of it keeps (ISS-1070).
 */
export function readNeedsYouAttention(
  projectId: string,
  viewer: NeedsYouViewer,
  now: Date = new Date(),
) {
  return attentionOf(projectId, viewer, now, listReleasesInPlay(projectId, viewer));
}

/** One attention read, as `readNeedsYouAttention` makes it; the project status's is wider and fits it. */
export type Attention = Awaited<ReturnType<typeof readNeedsYouAttention>>;

async function attentionOf<R extends Pick<ReleaseListResponse, 'releases'>>(
  projectId: string,
  viewer: NeedsYouViewer,
  now: Date,
  releasesRead: Promise<R>,
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
    designSettler,
  ] = await Promise.all([
    listRequirementsAs(viewer, projectId),
    listFeedbackAs(viewer, projectId),
    releasesRead,
    listIssueStanding(projectId, 'open', now),
    readContractStanding(projectId, viewer.userId, now),
    automationOf(projectId, viewer.userId, now),
    designHealthOf(viewer, projectId),
    questionRowsOf(projectId, viewer),
    designRepinsOf(viewer, projectId),
    designSettlerOf(projectId),
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
    contracts: contracts.contracts.map((c) => ({
      entity: 'contract',
      key: c.ref,
      ...writtenTitle(c.title, null),
      standing: c,
      touchedAt: c.touchedAt,
    })),
    questions: detached,
    designs: designRowsOf(health, repins, designSettler),
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
  return { rows, requirements, releases, issues, feedback: items, health, repins, contracts };
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

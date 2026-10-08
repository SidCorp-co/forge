/**
 * What waits on the viewer in one project, the one needs-you read model: each area calls the read
 * model its list calls, with the viewer that list's route builds, and keeps the rows that model
 * groups `needs_you` (`@forge/contracts/standing:needsViewer`). A second derivation is how a menu
 * count and the list it opens come to disagree (REQ-11 BC-10, BC-12).
 */

import { AUTOMATION_FIRES_DEFAULT } from '@forge/contracts/automation-standing';
import { FEEDBACK_UNTRIAGED_PHASES, type FeedbackPhase } from '@forge/contracts/feedback';
import {
  asksOf,
  NEEDS_YOU_AREA_SPACE,
  NEEDS_YOU_AREAS,
  type NeedsYouAct,
  type NeedsYouArea,
  type NeedsYouAreaKey,
  type NeedsYouEntity,
  type NeedsYouItem,
  type NeedsYouResponse,
} from '@forge/contracts/needs-you';
import type { ActorAgency } from '@forge/contracts/permissions';
import { say } from '@forge/contracts/said';
import { needsViewer, type Standing } from '@forge/contracts/standing';
import type { WorkflowHealth } from '@forge/contracts/workflow-health';
import { automationViewerOf, readAutomationStanding } from '../automation/index.js';
import { readContractStanding } from '../ecosystem/standing/read.js';
import { listFeedbackAs } from '../feedback/list-read.js';
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
}

function areaOf(rows: readonly AttentionRow[]): NeedsYouArea {
  // Tallied by what core said, not by its English, so two acts that read alike stay two.
  const tally = new Map<string, NeedsYouAct>();
  for (const row of rows) {
    const w = row.standing.waitingOn;
    const id = JSON.stringify(w.says.act);
    const seen = tally.get(id);
    tally.set(
      id,
      seen
        ? { ...seen, count: seen.count + 1 }
        : { act: w.act, count: 1, says: { act: w.says.act } },
    );
  }
  const acts = [...tally.values()].sort((a, b) => b.count - a.count || a.act.localeCompare(b.act));
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

const newestFirst = (a: AttentionRow, b: AttentionRow) =>
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
    })),
    releases: releases.releases.map((r) => ({
      entity: 'release',
      key: r.version,
      ...(r.headline
        ? writtenTitle(r.headline, null)
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
    })),
    issues: issues.issues.map((i) => ({
      entity: 'issue',
      key: i.key,
      ...writtenTitle(i.title, i.writtenLang),
      standing: i.standing,
      touchedAt: i.standing.touchedAt,
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
      ...automation.reports.map(
        (r): AttentionRow => ({
          entity: 'report',
          key: r.id,
          ...writtenTitle(r.summary, r.writtenLang),
          standing: r,
          touchedAt: r.createdAt,
        }),
      ),
    ],
  };
  return { rows, requirements, releases, issues, feedback: items };
}

export async function readNeedsYou(
  projectId: string,
  viewer: NeedsYouViewer,
  now: Date = new Date(),
): Promise<NeedsYouResponse> {
  const { rows, requirements, feedback } = await readAttention(projectId, viewer, now);
  const owed = Object.fromEntries(
    Object.entries(rows).map(([area, list]) => [
      area,
      list.filter((r) => needsViewer(r.standing)).sort(newestFirst),
    ]),
  ) as Record<NeedsYouAreaKey, AttentionRow[]>;
  const items = NEEDS_YOU_AREAS.flatMap((area) =>
    owed[area].map(
      (r): NeedsYouItem => ({
        area,
        space: NEEDS_YOU_AREA_SPACE[area],
        entity: r.entity,
        key: r.key,
        title: r.title,
        titleLang: r.titleLang,
        waitingOn: r.standing.waitingOn,
        touchedAt: r.touchedAt,
        says: { title: r.says.title },
      }),
    ),
  );
  return {
    generatedAt: now.toISOString(),
    areas: Object.fromEntries(
      Object.entries(owed).map(([area, list]) => [area, areaOf(list)]),
    ) as Record<NeedsYouAreaKey, NeedsYouArea>,
    items,
    asks: asksOf(items).length,
    requirementsInDelivery: requirements.filter((r) => r.standing.state === 'in_delivery').length,
    untriagedFeedback: feedback.filter((f) => UNTRIAGED.has(f.phase)).length,
  };
}

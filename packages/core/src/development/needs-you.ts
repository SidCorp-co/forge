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
  type NeedsYouAct,
  type NeedsYouArea,
  type NeedsYouAreaKey,
  type NeedsYouEntity,
  type NeedsYouItem,
  type NeedsYouResponse,
} from '@forge/contracts/needs-you';
import type { ActorAgency } from '@forge/contracts/permissions';
import { needsViewer, type Standing } from '@forge/contracts/standing';
import { automationViewerOf, readAutomationStanding } from '../automation/index.js';
import { readContractStanding } from '../ecosystem/standing/read.js';
import { listFeedbackAs } from '../feedback/list-read.js';
import { listIssueStanding } from '../issues/standing-read.js';
import { listReleases } from '../release-batch/release-read.js';
import { listRequirementsAs } from '../requirements/read.js';
import { designRowOf } from './needs-you-design.js';
import { questionRowsOf } from './needs-you-question.js';
import { designHealthOf } from './ports.js';

export interface NeedsYouViewer {
  userId: string;
  agency: ActorAgency;
  isAdmin: boolean;
  /** Holds releases.approve (`permissions/can.ts:holds`). */
  mayApprove: boolean;
  /** Holds project.write: the grant an answer to a question takes. */
  mayWrite: boolean;
}

interface Row {
  entity: NeedsYouEntity;
  key: string;
  title: string;
  standing: Standing;
  touchedAt: string | null;
}

function areaOf(rows: readonly Row[]): NeedsYouArea {
  // Tallied by what core said, not by its English, so two acts that read alike stay two.
  const tally = new Map<string, NeedsYouAct>();
  for (const row of rows) {
    const w = row.standing.waitingOn;
    const id = JSON.stringify(w.says.act);
    const seen = tally.get(id);
    tally.set(id, seen ? { ...seen, count: seen.count + 1 } : { act: w.act, count: 1, says: { act: w.says.act } });
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

const newestFirst = (a: Row, b: Row) => (b.touchedAt ?? '').localeCompare(a.touchedAt ?? '');

export async function readNeedsYou(
  projectId: string,
  viewer: NeedsYouViewer,
  now: Date = new Date(),
): Promise<NeedsYouResponse> {
  const [requirements, feedback, releases, issues, contracts, automation, health, detached] =
    await Promise.all([
      listRequirementsAs(viewer, projectId),
      listFeedbackAs(viewer, projectId),
      listReleases(projectId, viewer),
      listIssueStanding(projectId, 'open', { userId: viewer.userId }, now),
      readContractStanding(projectId, viewer.userId, now),
      automationOf(projectId, viewer.userId, now),
      designHealthOf(viewer, projectId),
      questionRowsOf(projectId, viewer),
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
    questions: detached,
    designs: [...health.values()].flatMap((h) => designRowOf(h) ?? []),
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

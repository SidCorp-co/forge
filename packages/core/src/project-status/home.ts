/**
 * The project home's one read (REQ-43 BC-14..BC-18): every figure the home draws, counted from the
 * lists the pages behind it read — the attention read's requirements, feedback, releases and open
 * issues (the Requirements, Feedback, Releases and Issues pages' own reads), the debt ledger, and the
 * Needs you decisions made from that same attention read. It derives no fact those lists do not
 * already decide, so a figure here equals the list it opens (L-57).
 */

import type { DebtLedgerView } from '@forge/contracts/cleanup';
import { DEBT_KINDS, IMPACT_RATINGS, IMPACT_TYPES } from '@forge/contracts/cleanup';
import { dayKeyIn, daysEnding } from '@forge/contracts/day-keys';
import { countsAsReport, type FeedbackSummary } from '@forge/contracts/feedback';
import { ISSUE_STATUSES } from '@forge/contracts/issue-machine';
import type { IssueStandingList } from '@forge/contracts/issue-standing';
import { byDecisionOrder, capDecisions } from '@forge/contracts/needs-you-decisions';
import {
  criteriaByAreaOf,
  feedbackOutcomeOf,
  feedbackWeeksOf,
  type HomeAudit,
  type HomeAuditCell,
  type HomeCount,
  type HomeDelivery,
  type HomeProduct,
  type HomeRelease,
  type HomeReleaseStage,
  PROJECT_HOME_DAYS,
  PROJECT_HOME_ISSUES,
  PROJECT_HOME_PLACES,
  PROJECT_HOME_RECENT,
  PROJECT_HOME_TIMELINE_MAX,
  type ProjectHome,
  requirementInPlay,
  shipDaysOf,
} from '@forge/contracts/project-home';
import { RELEASE_STATES, type ReleaseSummary } from '@forge/contracts/releases';
import { REQUIREMENT_STATES, type RequirementSummary } from '@forge/contracts/requirements';
import { NEEDS_YOU_PERSON_CAP } from '@forge/contracts/steward';
import { readLedger } from '../cleanup/index.js';
import { needsYouDecisionsOf, readAttention } from '../development/index.js';
import type { StatusViewer } from './read.js';

/** Each key of `order` that holds a count in `tally`, in that order. */
function countsIn<K extends string>(order: readonly K[], tally: Map<K, number>): HomeCount<K>[] {
  return order.flatMap((key) => {
    const count = tally.get(key) ?? 0;
    return count > 0 ? [{ key, count }] : [];
  });
}

function tallyOf<T, K>(items: readonly T[], keyOf: (item: T) => K): Map<K, number> {
  const tally = new Map<K, number>();
  for (const item of items) tally.set(keyOf(item), (tally.get(keyOf(item)) ?? 0) + 1);
  return tally;
}

export function productOf(
  requirements: readonly RequirementSummary[],
  feedback: readonly FeedbackSummary[],
): HomeProduct {
  const playing = requirements.filter(requirementInPlay);
  return {
    requirements: playing.length,
    byState: countsIn(
      REQUIREMENT_STATES,
      tallyOf(playing, (r) => r.standing.state),
    ),
    ...criteriaByAreaOf(requirements),
    feedbackOpen: feedback.filter((f) => countsAsReport(f) && feedbackOutcomeOf(f) === 'open')
      .length,
  };
}

export function deliveryOf(list: Pick<IssueStandingList, 'issues' | 'counts'>): HomeDelivery {
  const newest = [...list.issues].sort((a, b) =>
    b.standing.touchedAt.localeCompare(a.standing.touchedAt),
  );
  return {
    open: list.counts.open,
    byStatus: countsIn(
      ISSUE_STATUSES,
      tallyOf(list.issues, (i) => i.status),
    ),
    running: list.issues.filter((i) => i.standing.inFlight).length,
    issues: newest.slice(0, PROJECT_HOME_ISSUES).map((i) => ({
      key: i.key,
      title: i.title,
      titleLang: i.writtenLang,
      status: i.status,
      priority: i.priority,
      step: i.standing.step,
      touchedAt: i.standing.touchedAt,
      running: i.standing.inFlight,
    })),
    truncated: list.counts.open > Math.min(list.issues.length, PROJECT_HOME_ISSUES),
  };
}

const homeRelease = (r: ReleaseSummary & { releasedAt: string }): HomeRelease => ({
  version: r.version,
  name: r.name,
  issueCount: r.issueCount,
  releasedAt: r.releasedAt,
});

const isShipped = (r: ReleaseSummary): r is ReleaseSummary & { releasedAt: string } =>
  r.state === 'shipped' && r.releasedAt !== null;

/** The Release stage over the days ending `today`, counted from the Releases page's own list. */
export function releaseStageOf(
  releases: readonly ReleaseSummary[],
  dayOf: (at: string) => string,
  today: string,
): HomeReleaseStage {
  const first = daysEnding(today, PROJECT_HOME_DAYS)[0] ?? today;
  const shipped = releases
    .filter(isShipped)
    .sort((a, b) => a.releasedAt.localeCompare(b.releasedAt));
  const inWindow = shipped.filter((r) => dayOf(r.releasedAt) >= first);
  // every release cut in the window, by where it stands: a draft is not cut, so it is not counted
  const cut = releases.filter(
    (r) => r.state !== 'draft' && dayOf(r.releasedAt ?? r.openedAt ?? r.at) >= first,
  );
  return {
    days: shipDaysOf(releases, dayOf, today),
    shipped: inWindow.length,
    issues: inWindow.reduce((n, r) => n + r.issueCount, 0),
    byState: countsIn(
      RELEASE_STATES,
      tallyOf(cut, (r) => r.state),
    ),
    timeline: inWindow.slice(-PROJECT_HOME_TIMELINE_MAX).map(homeRelease),
    recent: shipped.slice(-PROJECT_HOME_RECENT).reverse().map(homeRelease),
  };
}

/** Where a finding sits, named by its first word's last path part: `issues/standing.ts` reads `standing.ts`. */
export const placeOf = (where: string): string => {
  const first = where.trim().split(/\s+/)[0] ?? where;
  return first.replace(/\/+$/, '').split('/').at(-1) || first;
};

export function auditOf(ledger: Pick<DebtLedgerView, 'open' | 'cleared'>): HomeAudit {
  const cells = new Map<string, HomeAuditCell & { all: Map<string, number> }>();
  for (const d of ledger.open) {
    const id = `${d.impact.type}:${d.kind}`;
    const cell = cells.get(id) ?? {
      type: d.impact.type,
      kind: d.kind,
      count: 0,
      places: [],
      all: new Map<string, number>(),
    };
    cell.count += 1;
    const place = placeOf(d.where);
    cell.all.set(place, (cell.all.get(place) ?? 0) + 1);
    cells.set(id, cell);
  }
  const order = (c: HomeAuditCell) =>
    IMPACT_TYPES.indexOf(c.type) * DEBT_KINDS.length + DEBT_KINDS.indexOf(c.kind);
  return {
    open: ledger.open.length,
    cleared: ledger.cleared.length,
    byKind: countsIn(
      DEBT_KINDS,
      tallyOf(ledger.open, (d) => d.kind),
    ),
    byRating: countsIn(
      IMPACT_RATINGS,
      tallyOf(ledger.open, (d) => d.impact.rating),
    ),
    cells: [...cells.values()]
      .map(({ all, ...cell }) => ({
        ...cell,
        places: [...all]
          .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
          .slice(0, PROJECT_HOME_PLACES)
          .map(([where, count]) => ({ where, count })),
      }))
      .sort((a, b) => order(a) - order(b)),
  };
}

export async function readProjectHome(
  projectId: string,
  viewer: StatusViewer,
  tz: string,
  now: Date = new Date(),
): Promise<ProjectHome> {
  const [read, ledger] = await Promise.all([
    readAttention(projectId, viewer, now),
    readLedger(projectId),
  ]);
  const decisions = [...(await needsYouDecisionsOf(projectId, viewer, viewer.access, read))].sort(
    byDecisionOrder,
  );
  const dayOf = dayKeyIn(tz);
  const today = dayOf(now);
  return {
    projectId,
    asOf: now.toISOString(),
    tz,
    product: productOf(read.requirements, read.feedback),
    delivery: deliveryOf(read.issues),
    release: releaseStageOf(read.releases.releases, dayOf, today),
    audit: auditOf(ledger),
    feedback: { weeks: feedbackWeeksOf(read.feedback, dayOf, today) },
    needsYou: {
      decisions: capDecisions(decisions, NEEDS_YOU_PERSON_CAP).shown,
      total: decisions.length,
    },
  };
}

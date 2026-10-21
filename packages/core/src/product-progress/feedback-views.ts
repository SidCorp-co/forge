// What project_feedback and forge_feedback answer for one item: the feedback screen's own read, cut to what a BA acts
// on, and the progress block (`product-progress.ts`) of the work the item was routed to.

import type { FeedbackSummary, FeedbackView } from '@forge/contracts/feedback';
import type { FeedbackForecast } from '@forge/contracts/forecast';
import type { RunStanding } from '@forge/contracts/run-standing';
import { issueProgressOf } from '../forecast/index.js';
import {
  type Progress,
  type ProgressWait,
  pausedWait,
  progressOf,
  runsOn,
  type WorkIssue,
} from './progress.js';

/** What one answer reads once and every item of it shares. */
export interface FeedbackReads {
  asOf: string;
  forecasts: Map<string, FeedbackForecast>;
  runs: Map<string, RunStanding[]>;
  /** The issues of each requirement an item was routed to, by REQ key. */
  requirementIssues: Map<string, WorkIssue[]>;
  /** Every item of the project by key, to follow a duplicate to its root. */
  items: Map<string, FeedbackSummary>;
}

/** The requirement keys the items were routed to as a new requirement, which their work is. */
export function routedRequirements(items: readonly FeedbackSummary[]): string[] {
  return items.flatMap((s) =>
    s.route?.route === 'new_requirement' && s.route.carriers[0]?.key
      ? [s.route.carriers[0].key]
      : [],
  );
}

/** The item a duplicate was merged into, followed to the end; the item itself where it is none. */
function rootOf(s: FeedbackSummary, reads: FeedbackReads): FeedbackSummary {
  let at = s;
  for (const seen = new Set<string>(); at.route?.route === 'duplicate' && !seen.has(at.key); ) {
    seen.add(at.key);
    const next = at.route.carriers[0]?.key;
    const root = next ? reads.items.get(next) : undefined;
    if (!root) return at;
    at = root;
  }
  return at;
}

/** The issues the item's work is: its route's carriers, or the issues of the requirement it became. */
function workOf(s: FeedbackSummary, reads: FeedbackReads): WorkIssue[] {
  const route = s.route;
  if (route?.route === 'issue') {
    return route.carriers.flatMap((c) => (c.key ? [{ key: c.key, status: c.status ?? '' }] : []));
  }
  if (route?.route === 'new_requirement') {
    const req = route.carriers[0]?.key;
    return req ? (reads.requirementIssues.get(req) ?? []) : [];
  }
  return [];
}

/** Why an item has no delivery to forecast, said from its phase and route. */
function noDeliveryOf(s: FeedbackSummary, root: FeedbackSummary): string {
  const of = root === s ? '' : `it duplicates ${root.key}, and `;
  const r = root.route;
  if (root.snoozed) return `${of}it is snoozed until ${root.snoozed.until.slice(0, 10)}`;
  if (root.phase === 'new' || root.phase === 'reopened') return `${of}it is not triaged yet`;
  if (root.phase === 'declined') return `${of}it was declined, so no work will ship for it`;
  if (r?.route === 'answer') return `${of}it was answered, so no work ships for it`;
  if (r?.route === 'revision') {
    return `${of}it was routed to a revision of a requirement, and no issue carries that revision until it is agreed and broken down`;
  }
  if (r?.route === 'new_requirement') {
    return `${of}it became ${r.carriers[0]?.key ?? 'a requirement'}, which no issue carries yet`;
  }
  return `${of}no work that ships is linked to it (${root.phase})`;
}

/** The progress block of one item, from the reads its answer shares. */
export function feedbackProgress(s: FeedbackSummary, reads: FeedbackReads): Progress {
  const root = rootOf(s, reads);
  const forecast = reads.forecasts.get(s.key) ?? reads.forecasts.get(root.key);
  const work = workOf(root, reads);
  const waits: ProgressWait[] = [];
  for (const item of root === s ? [s] : [s, root]) {
    if (item.waitingOn.kind === 'none') continue;
    waits.push({
      who: item.waitingOn.who,
      act: item.waitingOn.act,
      why: item.waitingOn.rule,
      ref: item.waitingOn.ref,
      at: item.waitingOn.dueAt,
      late: false,
    });
  }
  if (forecast?.triage) waits.push(pausedWait(forecast.triage));
  return progressOf({
    asOf: reads.asOf,
    work: work.length > 0 ? issueProgressOf(work) : null,
    runs: runsOn(
      reads.runs,
      work.map((w) => w.key),
    ),
    waits,
    delivery: forecast?.delivery ?? null,
    noDelivery: noDeliveryOf(s, root),
  });
}

/** One row of the list. */
export function feedbackRow(s: FeedbackSummary, progress: Progress) {
  return {
    key: s.key,
    title: s.title,
    kind: s.kind,
    severity: s.severity,
    phase: s.phase,
    target: { type: s.target.type, key: s.target.key },
    route: s.route && {
      route: s.route.route,
      carriers: s.route.carriers.map((c) => c.key),
    },
    waitingOn: { who: s.waitingOn.who, act: s.waitingOn.act, why: s.waitingOn.rule },
    reporter: s.reporter.name,
    createdAt: s.createdAt,
    progress,
  };
}

/** One item in full, as a BA reads it before asking its reporter or telling them where it is. */
export function feedbackDetail(v: FeedbackView, progress: Progress) {
  return {
    ...feedbackRow(v, progress),
    body: v.body,
    whereSeen: v.whereSeen,
    route: v.route,
    duplicateOf: v.duplicateOf,
    duplicates: v.duplicates,
    clarification: v.clarification,
    decisions: v.decisions.map((d) => ({
      decision: d.decision,
      route: d.route,
      carrier: d.carrier,
      reason: d.reason,
      by: d.decidedByName,
      at: d.decidedAt,
    })),
    messages: v.messages.length,
    attachments: v.attachments.length,
    openSuggestions: v.openSuggestions,
    sensitive: v.sensitive,
  };
}

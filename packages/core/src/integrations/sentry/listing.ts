/**
 * ISS-1085 slice 3 — the vocabulary and the pure decisions of a Sentry issue LISTING.
 *
 * Split out of `issues.ts` when that file crossed its 500-line budget, and the seam is a real one
 * rather than a convenient place to cut: everything here is decided WITHOUT talking to Sentry —
 * what to ask for, how far to walk, and whether an answer belongs to the target that was named.
 * The call itself stays in `issues.ts` beside the other two, because it shares their delivery row,
 * their token rotation and their health verdict.
 */

import type { OutboundDispatchResult } from '../types.js';
import type { ResolvedSentryTarget } from './targets.js';
import type { SentryIssueDetail } from './types.js';

/** What a pull asks Sentry for when the caller names nothing narrower. */
export const SENTRY_LIST_DEFAULT_QUERY = 'is:unresolved';
export const SENTRY_LIST_DEFAULT_LIMIT = 25;
export const SENTRY_LIST_MAX_LIMIT = 100;
/**
 * How many pages one listing will walk before it stops and SAYS it stopped.
 *
 * A bound is needed — an unbounded follow of a provider's own cursor is a loop whose length the
 * provider chooses. What must never happen is the bound being reached quietly: Sentry orders by
 * last seen, so the issues past the last page are the same ones on every tick, and a pull that
 * stopped short without saying so is a permanent blind spot wearing the word `success`.
 */
export const SENTRY_LIST_MAX_PAGES = 10;

/** One listing's request, and the same shape its delivery row records. */
export interface SentryListRequest {
  targetLabel?: string;
  /** Sentry search syntax. The target's own `project:<slug>` is appended by this module. */
  query?: string;
  limit?: number;
}

/**
 * One answer this listing would not hand on, and why.
 *
 * Kept per answer rather than counted, because an operator whose target is mis-declared has to know
 * WHICH Sentry project answered before they can fix it — a number tells them only that something
 * did (ISS-1085 slice 3).
 */
export interface SentryListRefusal {
  issueId: string;
  shortId: string | null;
  /** The project Sentry said it belongs to; null where Sentry named none. */
  belongsTo: string | null;
  reason: string;
}

export interface SentryIssueListing {
  result: OutboundDispatchResult;
  target: ResolvedSentryTarget;
  /** The answers that survived confinement, in the order Sentry returned them. */
  issues: SentryIssueDetail[];
  /** Every answer that did not, named individually. */
  refused: SentryListRefusal[];
  /** How many pages were walked. */
  pages: number;
  /** True where Sentry still had more and this listing stopped at its own bound. */
  truncated: boolean;
}

/**
 * Sentry's cursor for the NEXT page, or `null` where there is not one.
 *
 * Sentry paginates by `Link` header rather than by a field in the body, and it always emits a
 * `rel="next"` — `results="true"` is the only thing that says the page is real. Reading the
 * presence of the header as "there is more" would make every listing loop to its page bound.
 */
export function nextSentryCursor(link: string | null): string | null {
  if (!link) return null;
  for (const part of link.split(/,\s*(?=<)/)) {
    if (!/rel="next"/.test(part)) continue;
    if (!/results="true"/.test(part)) return null;
    const cursor = part.match(/cursor="([^"]*)"/);
    return cursor?.[1] ?? null;
  }
  return null;
}

export function assertListLimit(limit: unknown): number {
  if (limit === undefined) return SENTRY_LIST_DEFAULT_LIMIT;
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1) {
    throw new Error(
      `sentry: ${JSON.stringify(limit)} is not a listing limit — it has to be a whole number of at least 1`,
    );
  }
  if (limit > SENTRY_LIST_MAX_LIMIT) {
    throw new Error(
      `sentry: a listing limit of ${limit} is above the ${SENTRY_LIST_MAX_LIMIT} this adapter will ask for in one call`,
    );
  }
  return limit;
}

/** The caller's query, with the target's own project scoping appended rather than assumed. */
export function listQuery(query: string | undefined, target: ResolvedSentryTarget): string {
  const base = query?.trim() ? query.trim() : SENTRY_LIST_DEFAULT_QUERY;
  if (!target.projectSlug) return base;
  return `${base} project:${target.projectSlug}`;
}

/**
 * Why this answer is not this target's, or `null` where it is.
 *
 * Same rule as `assertTargetHoldsIssue`, which refuses one addressed issue; this one reports rather
 * than throws, because a listing that threw on the first foreign answer would take the whole pull
 * down over one mis-scoped row instead of naming it.
 */
export function confinementRefusal(
  issue: SentryIssueDetail,
  target: ResolvedSentryTarget,
): string | null {
  if (!target.projectSlug) return null;
  if (issue.projectSlug === null) {
    return `Sentry named no project for this issue, so it cannot be confined to target "${target.label}" (scoped to ${target.projectSlug})`;
  }
  if (issue.projectSlug !== target.projectSlug) {
    return `belongs to project ${issue.projectSlug}, and target "${target.label}" is scoped to ${target.projectSlug}`;
  }
  return null;
}

import type { OutboundDispatchResult } from '../types.js';
import type { ResolvedSentryTarget } from './targets.js';
import type { SentryIssueDetail } from './types.js';

/** What a pull asks Sentry for when the caller names nothing narrower. */
export const SENTRY_LIST_DEFAULT_QUERY = 'is:unresolved';
export const SENTRY_LIST_DEFAULT_LIMIT = 100;
export const SENTRY_LIST_MAX_LIMIT = 100;
export const SENTRY_LIST_MAX_PAGES = 10;

/** One listing's request, and the same shape its delivery row records. */
export interface SentryListRequest {
  targetLabel?: string;
  /** Sentry search syntax. The target's own `project:<slug>` is appended by this module. */
  query?: string;
  limit?: number;
}

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

export class SentryListingFailed extends Error {
  constructor(
    message: string,
    readonly partial: { pages: number; refused: SentryListRefusal[] },
  ) {
    super(message);
    this.name = 'SentryListingFailed';
  }
}

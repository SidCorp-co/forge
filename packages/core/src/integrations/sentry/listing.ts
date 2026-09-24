import type { OutboundDispatchResult } from '../types.js';
import { SentryRefusal } from './refusals.js';
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
  /** Sentry's own window token — `24h`, `7d`. Absent leaves the window to Sentry's default. */
  statsPeriod?: string;
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
  /** The search Sentry was actually asked, target scoping included. */
  query: string;
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
    throw new SentryRefusal(
      'bad_argument',
      `sentry: ${JSON.stringify(limit)} is not a listing limit — it has to be a whole number of at least 1`,
    );
  }
  if (limit > SENTRY_LIST_MAX_LIMIT) {
    throw new SentryRefusal(
      'bad_argument',
      `sentry: a listing limit of ${limit} is above the ${SENTRY_LIST_MAX_LIMIT} this adapter will ask for in one call`,
    );
  }
  return limit;
}

/** Sentry's own ceiling on a relative window, in minutes. */
const SENTRY_MAX_STATS_PERIOD_MINUTES = 90 * 24 * 60;
const STATS_PERIOD_MINUTES: Record<string, number> = { m: 1, h: 60, d: 1440, w: 10_080 };

/**
 * The window as Sentry spells it, refused rather than dropped: a caller asking `did my deploy
 * break it` over the last hour and silently given Sentry's default answers a different question.
 */
export function assertStatsPeriod(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const bad = (why: string) =>
    new SentryRefusal(
      'bad_argument',
      `sentry: ${JSON.stringify(value)} is not a window — ${why}. Sentry takes a whole number and one of m, h, d or w, up to 90d: \`1h\`, \`24h\`, \`7d\`.`,
    );
  if (typeof value !== 'string') throw bad('a window is written as text');
  const match = /^(\d+)([mhdw])$/.exec(value.trim());
  if (!match) throw bad('it is not a count followed by a unit');
  const minutes = Number(match[1]) * (STATS_PERIOD_MINUTES[match[2] as string] ?? 0);
  if (minutes < 1) throw bad('a window of no time answers nothing');
  if (minutes > SENTRY_MAX_STATS_PERIOD_MINUTES) throw bad('it is longer than 90d');
  return value.trim();
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
    /** The refusal that stopped the walk, where one classified it. */
    readonly refusal: SentryRefusal | null = null,
  ) {
    super(message);
    this.name = 'SentryListingFailed';
  }
}

/**
 * The disclosure envelope every MCP list surface returns.
 *
 * Two caps can silently shorten a list: the caller's `limit`, and the hard
 * response-size budget that keeps a fat response from overflowing the MCP
 * output cap and killing the agent (ISS-428 / ISS-478). Only the second was
 * ever disclosed. ISS-787: an agent called `forge_issues action=list` with no
 * explicit limit, got 10 rows of 16, and reported "10 issues" into a release
 * cutoff decision — 10 of 16 and 10 of 10 were the same payload.
 *
 * So `returned`, `limit` and `hasMore` are emitted on EVERY response, complete
 * or not. `hasMore:false` is the load-bearing half: its absence today is
 * indistinguishable from a tool that has no such concept, which is what makes
 * a short list readable as a whole one.
 */

/** Hard total-response cap. ~38K leaves headroom under the MCP output cap. */
export const MAX_RESPONSE_CHARS = 38_000;

/**
 * The value to pass to `.limit()`. The extra row is never returned — it is
 * what makes {@link buildListEnvelope}'s `hasMore` exact.
 */
// cm:guard the caller MUST pass this to `.limit()` and the SAME `limit` to buildListEnvelope — deriving hasMore from `returned === limit` instead is wrong precisely when the result set size equals the limit, which is the case ISS-787 was filed about
export function overfetch(limit: number): number {
  return limit + 1;
}

export type TruncatedBy = 'limit' | 'response-size' | 'limit+response-size';

export interface ListEnvelopeArgs<T> {
  /** Payload key the tool answers under — `issues`, `jobs`, `reports`, … */
  key: string;
  /** Serialized rows AS FETCHED, i.e. up to `overfetch(limit)` of them. */
  items: T[];
  /** The effective limit the caller asked for (after the tool's default). */
  limit: number;
  /** What to narrow by, appended to the notice. Tool-specific. */
  hint: string;
  /** Which end of `items` the least-useful rows sit at, for the size trim. */
  oldestAt?: 'tail' | 'head';
  maxChars?: number;
}

/**
 * Trim `items` to what may be returned and describe what was dropped.
 *
 * The LIMIT trim always drops the tail — that is what `overfetch` fetched,
 * whatever the sort. The SIZE trim drops from `oldestAt`, so a `desc` query
 * (default) sheds its oldest rows and an `asc` one sheds them from the head.
 */
export function buildListEnvelope<T>(args: ListEnvelopeArgs<T>): Record<string, unknown> {
  const { key, items, limit, hint } = args;
  const maxChars = args.maxChars ?? MAX_RESPONSE_CHARS;

  const boundByLimit = items.length > limit;
  let kept = boundByLimit ? items.slice(0, limit) : items;

  const beforeSizeTrim = kept.length;
  const dropOne = args.oldestAt === 'head' ? (r: T[]) => r.slice(1) : (r: T[]) => r.slice(0, -1);
  while (kept.length > 1 && JSON.stringify({ [key]: kept }).length > maxChars) {
    kept = dropOne(kept);
  }
  const boundBySize = kept.length < beforeSizeTrim;

  const envelope: Record<string, unknown> = {
    [key]: kept,
    returned: kept.length,
    limit,
    hasMore: boundByLimit || boundBySize,
  };

  if (!boundByLimit && !boundBySize) return envelope;

  const truncatedBy: TruncatedBy =
    boundByLimit && boundBySize ? 'limit+response-size' : boundByLimit ? 'limit' : 'response-size';

  envelope.truncated = true;
  envelope.truncatedBy = truncatedBy;
  envelope.notice = buildNotice(kept.length, truncatedBy, limit, hint);
  return envelope;
}

// cm:guard never state a count that reads as a DB total — the only numbers here are `returned` and the caller's own `limit`, both of which the caller can verify. forge_feedback and forge_ux_findings used to say "the N most recent of M" where M was the rows already bounded by the limit; an agent read that as a total and it never was one.
function buildNotice(returned: number, by: TruncatedBy, limit: number, hint: string): string {
  const cause =
    by === 'response-size'
      ? `the response-size cap cut this to the ${returned} most recent`
      : by === 'limit'
        ? `your limit of ${limit} bound this to the ${returned} most recent`
        : `your limit of ${limit} and then the response-size cap bound this to the ${returned} most recent`;
  const remedy =
    by === 'limit'
      ? `Raise limit or ${hint} to see the rest.`
      : `A higher limit will NOT help — ${hint} instead.`;
  return `More rows match than were returned: ${cause}. ${remedy}`;
}

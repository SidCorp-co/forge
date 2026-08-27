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
  /** Sort order of `items`. `desc` (the default) means newest first. */
  order?: 'desc' | 'asc';
  /**
   * Which end the SIZE trim sheds. Default `oldest`, which is what a reader
   * of a thread or a feed wants.
   */
  // cm:guard a CURSOR-paginated surface must pass 'newest' — shedding the oldest rows moves the cursor past events the caller has not seen, and they are never replayed. forge_jobs.events is the one such caller.
  sizeTrimSheds?: 'oldest' | 'newest';
  maxChars?: number;
}

/**
 * Trim `items` to what may be returned and describe what was dropped.
 *
 * The LIMIT trim always drops the tail — that is where `overfetch` put the
 * probe row, whatever the sort. The SIZE trim drops from whichever end
 * {@link ListEnvelopeArgs.sizeTrimSheds} names, resolved against `order`.
 */
export function buildListEnvelope<T>(args: ListEnvelopeArgs<T>): Record<string, unknown> {
  const { key, items, limit, hint } = args;
  const maxChars = args.maxChars ?? MAX_RESPONSE_CHARS;
  const ascending = args.order === 'asc';
  const shedsNewest = args.sizeTrimSheds === 'newest';

  const boundByLimit = items.length > limit;
  const withinLimit = boundByLimit ? items.slice(0, limit) : items;

  const shedFromHead = ascending ? !shedsNewest : shedsNewest;
  const kept = trimToBudget(key, withinLimit, maxChars, shedFromHead);
  const boundBySize = kept.length < withinLimit.length;

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
  envelope.notice = buildNotice({ returned: kept.length, truncatedBy, limit, hint, ascending, shedsNewest });
  return envelope;
}

/**
 * Drop rows from one end until the serialized payload fits. Sizes are measured
 * once and subtracted, rather than re-serializing the survivors per drop —
 * `forge_jobs.events` can hand this 200 rows carrying the whole agent
 * transcript, and the naive loop is quadratic in exactly that case.
 */
function trimToBudget<T>(key: string, items: T[], maxChars: number, fromHead: boolean): T[] {
  const overhead = JSON.stringify({ [key]: [] }).length;
  const sizes = items.map((item) => JSON.stringify(item).length + 1);
  let total = overhead + sizes.reduce((a, b) => a + b, 0);
  let head = 0;
  let tail = items.length;
  while (head < tail && total > maxChars) {
    const dropAt = fromHead ? head++ : --tail;
    total -= sizes[dropAt] ?? 0;
  }
  return head === 0 && tail === items.length ? items : items.slice(head, tail);
}

// cm:guard never state a count that reads as a DB total — the only numbers here are `returned` and the caller's own `limit`, both of which the caller can verify. forge_feedback and forge_ux_findings used to say "the N most recent of M" where M was the rows already bounded by the limit; an agent read that as a total and it never was one.
// cm:guard name WHICH rows survived, not just how many — the two trims drop from opposite ends on an ascending list, so "the N most recent" is false there and sends the caller looking for rows it already has
function buildNotice(args: {
  returned: number;
  truncatedBy: TruncatedBy;
  limit: number;
  hint: string;
  ascending: boolean;
  shedsNewest: boolean;
}): string {
  const { returned, truncatedBy: by, limit, hint } = args;
  const underLimit = args.ascending ? `the first ${returned} in order` : `the ${returned} most recent`;
  const underSize = args.shedsNewest
    ? `the first ${returned} of them in order`
    : `the ${returned} most recent of them`;
  const cause =
    by === 'response-size'
      ? `the response-size cap cut this to ${underSize}`
      : by === 'limit'
        ? `your limit of ${limit} bound this to ${underLimit}`
        : `your limit of ${limit} bound this to the first ${limit}, and the response-size cap then cut those to ${underSize}`;
  const remedy =
    by === 'limit'
      ? `Raise limit or ${hint} to see the rest.`
      : `A higher limit will NOT help — ${hint} instead.`;
  return `More rows match than were returned: ${cause}. ${remedy}`;
}

/** Hard total-response cap. ~38K leaves headroom under the MCP output cap. */
export const MAX_RESPONSE_CHARS = 38_000;

/**
 * The value to pass to `.limit()`. The extra row is never returned — it is
 * what makes {@link buildListEnvelope}'s `hasMore` exact.
 */
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
  sizeTrimSheds?: 'oldest' | 'newest';
  maxChars?: number;
  /**
   * Makes this a cursor surface: `more` is whether the query found rows after
   * this page, and `of` mints the token that resumes after one item.
   */
  cursor?: { more: boolean; of: (item: T) => string };
}

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

  const trimmed = boundByLimit || boundBySize;
  const lastKept = kept.at(-1);
  const nextCursor =
    args.cursor && (trimmed || args.cursor.more) && lastKept !== undefined
      ? args.cursor.of(lastKept)
      : null;

  const envelope: Record<string, unknown> = {
    [key]: kept,
    returned: kept.length,
    limit,
    hasMore: args.cursor ? nextCursor !== null : trimmed,
  };
  if (args.cursor) envelope.nextCursor = nextCursor;

  if (!trimmed) return envelope;

  const truncatedBy: TruncatedBy =
    boundByLimit && boundBySize ? 'limit+response-size' : boundByLimit ? 'limit' : 'response-size';

  envelope.truncated = true;
  envelope.truncatedBy = truncatedBy;
  envelope.notice = buildNotice({
    returned: kept.length,
    truncatedBy,
    limit,
    hint,
    ascending,
    shedsNewest,
    resumable: nextCursor !== null,
  });
  return envelope;
}

function trimToBudget<T>(key: string, items: T[], maxChars: number, fromHead: boolean): T[] {
  const overhead = JSON.stringify({ [key]: [] }).length;
  const sizes = items.map((item) => JSON.stringify(item).length + 1);
  let total = overhead + sizes.reduce((a, b) => a + b, 0);
  let head = 0;
  let tail = items.length;
  while (tail - head > 1 && total > maxChars) {
    const dropAt = fromHead ? head++ : --tail;
    total -= sizes[dropAt] ?? 0;
  }
  return head === 0 && tail === items.length ? items : items.slice(head, tail);
}

function buildNotice(args: {
  returned: number;
  truncatedBy: TruncatedBy;
  limit: number;
  hint: string;
  ascending: boolean;
  shedsNewest: boolean;
  resumable?: boolean;
}): string {
  const { returned, truncatedBy: by, limit, hint } = args;
  const underLimit = args.ascending
    ? `the first ${returned} in order`
    : `the ${returned} most recent`;
  const underSize = args.shedsNewest
    ? `the first ${returned} of them in order`
    : `the ${returned} most recent of them`;
  const cause =
    by === 'response-size'
      ? `the response-size cap cut this to ${underSize}`
      : by === 'limit'
        ? `your limit of ${limit} bound this to ${underLimit}`
        : `your limit of ${limit} bound this to the first ${limit}, and the response-size cap then cut those to ${underSize}`;
  const remedy = args.resumable
    ? 'Pass `nextCursor` back as `cursor` to read the next page; repeat until it is null.'
    : by === 'limit'
      ? `Raise limit or ${hint} to see the rest.`
      : `A higher limit will NOT help — ${hint} instead.`;
  return `More rows match than were returned: ${cause}. ${remedy}`;
}

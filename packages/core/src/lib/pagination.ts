/**
 * The REST list contract. Three shapes, each named, and no fourth.
 *
 * ISS-889 — a list must answer "is this everything?" in its BODY, the way
 * `mcp/tools/list-envelope.ts` does. A header cannot: a handler can forget to
 * set one, or a CORS config can stop exposing it, and the response still parses
 * as a complete list.
 *
 *   listResponse   the caller pages by offset → items + total + limit/offset + hasMore
 *   cursorList     the caller pages by cursor → items + total + limit + nextCursor + hasMore
 *   wholeList      the caller cannot page     → items + total, hasMore always false
 *
 * ISS-956 added the third. A keyset route can state neither of the other two
 * honestly: it has no `offset` to report, and `wholeList` says `hasMore` off a
 * count it cannot compare a page against. The rule the first two were written
 * for is unchanged — `setTotalCount` stays module-private, `hasMore` is
 * derived here rather than passed in, and no route builds the object itself.
 *
 * REST answers this better than MCP can, and the envelope says so: `total` is a
 * real `count()`, where MCP infers `hasMore` from one overfetched row.
 */

import type { Context } from 'hono';
import { z } from 'zod';

export const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export type Pagination = z.infer<typeof paginationSchema>;

/** `Pagination` for the routes whose query is 1-based `page` + `pageSize`. */
export function fromPage(page: number, pageSize: number): Pagination {
  return { limit: pageSize, offset: (page - 1) * pageSize };
}

/** What every REST list answers with. */
export type ListEnvelope<T> = {
  items: T[];
  /** Rows in THIS response. */
  returned: number;
  /** Rows matching the query, ignoring limit/offset. */
  total: number;
  limit: number;
  offset: number;
  /** Are there rows after this page? */
  hasMore: boolean;
};

// cm:guard NOT exported, deliberately. The header is a second copy of an answer the body now carries, and a route that sets it by hand can state a total its payload contradicts — which is the whole defect ISS-889 found. Keeping it module-private makes the three helpers below the only way to emit a list, enforced by the compiler rather than by review.
// cm:edge contract -> packages/core/src/index.ts — `exposeHeaders: ['X-Total-Count']` is what lets a browser read this at all; the body carries the same number, so dropping it degrades rather than breaks
function setTotalCount(c: Context, total: number): void {
  c.header('X-Total-Count', String(total));
}

/**
 * Answer a paginated list — one the caller can ask for more of.
 *
 * `page` is the validated `limit`/`offset` the query was run with, so the
 * envelope describes the request that produced these rows rather than a
 * separately-computed guess.
 */
// cm:guard `hasMore` is derived from offset + returned against `total`, NEVER from `returned === limit` — those differ exactly when the result set size equals the limit, which is the case ISS-787 was filed about on the MCP side. No route builds this object itself, so that trap has one place to be got right.
export function listResponse<T>(
  c: Context,
  items: T[],
  total: number,
  page: Pagination,
): ListEnvelope<T> {
  setTotalCount(c, total);
  return {
    items,
    returned: items.length,
    total,
    limit: page.limit,
    offset: page.offset,
    hasMore: page.offset + items.length < total,
  };
}

/** What a cursor-paged REST list answers with. */
export type CursorListEnvelope<T> = {
  items: T[];
  /** Rows in THIS response. */
  returned: number;
  /** Rows matching the query, ignoring the page bound. */
  total: number;
  /** The page bound these rows were read under. */
  limit: number;
  /** Hand this back to continue; null means the walk reached the end. */
  nextCursor: string | null;
  hasMore: boolean;
};

/**
 * Answer a list the caller pages with a cursor rather than an offset.
 *
 * `total` counts every row the query matches, so a caller can show progress
 * through a walk; it is NOT what `hasMore` is derived from.
 */
// cm:guard `hasMore` is `nextCursor !== null` and nothing else. Deriving it from `returned < total` instead is wrong on exactly the page that matters: a REST comment page carries roots while `total` counts replies too, so `returned < total` is true on a thread that has already been walked to its end, and a client that trusts it never stops paging. ISS-956 AC 6 measures this equality.
export function cursorList<T>(
  c: Context,
  items: T[],
  total: number,
  page: { limit: number; nextCursor: string | null },
): CursorListEnvelope<T> {
  setTotalCount(c, total);
  return {
    items,
    returned: items.length,
    total,
    limit: page.limit,
    nextCursor: page.nextCursor,
    hasMore: page.nextCursor !== null,
  };
}

/**
 * Answer a list the caller cannot page through: the query takes no limit and
 * offset, or it is bounded by a fixed cap rather than by the caller.
 *
 * `total` may still exceed `items.length` — a capped list knows how many rows
 * matched even when it may not return them all. `hasMore` reports that, and it
 * is the honest signal a caller gets in place of a next page.
 */
// cm:guard reach for this ONLY when there is nothing to page with — no limit/offset AND no cursor. Using it on a paginated route states `offset: 0` and hides a real next page, which reads to a caller as a complete list — the exact failure the envelope exists to prevent, wearing the envelope's own shape. ISS-956 is the case in point: the comments route reached for it while capped at 1000 rows, and `hasMore: true` with no way to ask for more is what a client could not act on.
export function wholeList<T>(c: Context, items: T[], total?: number): ListEnvelope<T> {
  const resolved = total ?? items.length;
  setTotalCount(c, resolved);
  return {
    items,
    returned: items.length,
    total: resolved,
    limit: items.length,
    offset: 0,
    hasMore: items.length < resolved,
  };
}

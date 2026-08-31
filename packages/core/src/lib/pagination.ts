/**
 * The REST list contract. Two shapes, both named, and no third.
 *
 * ISS-889 — a list must answer "is this everything?" in its BODY, the way
 * `mcp/tools/list-envelope.ts` does. A header cannot: a handler can forget to
 * set one, or a CORS config can stop exposing it, and the response still parses
 * as a complete list.
 *
 *   listResponse   the caller can page      → items + total + limit/offset + hasMore
 *   wholeList      the caller cannot page   → items + total, hasMore always false
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

// cm:guard NOT exported, deliberately. The header is a second copy of an answer the body now carries, and a route that sets it by hand can state a total its payload contradicts — which is the whole defect ISS-889 found. Keeping it module-private makes the two helpers below the only way to emit a list, enforced by the compiler rather than by review.
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

/**
 * Answer a list the caller cannot page through: the query takes no limit and
 * offset, or it is bounded by a fixed cap rather than by the caller.
 *
 * `total` may still exceed `items.length` — a capped list knows how many rows
 * matched even when it may not return them all. `hasMore` reports that, and it
 * is the honest signal a caller gets in place of a next page.
 */
// cm:guard reach for this ONLY when there is no limit/offset to page with. Using it on a paginated route states `offset: 0` and hides a real next page, which reads to a caller as a complete list — the exact failure the envelope exists to prevent, wearing the envelope's own shape.
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

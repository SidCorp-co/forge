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

function setTotalCount(c: Context, total: number): void {
  c.header('X-Total-Count', String(total));
}

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

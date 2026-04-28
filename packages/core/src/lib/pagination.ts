import type { Context } from 'hono';
import { z } from 'zod';

export const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export type Pagination = z.infer<typeof paginationSchema>;

export function setTotalCount(c: Context, total: number): void {
  c.header('X-Total-Count', String(total));
}

import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';

export const idParamSchema = z.object({
  id: z.uuid(),
});

/**
 * `z.flattenError`, with the path a nested field is actually at: `flattenError` buckets every
 * issue under its TOP-LEVEL key and drops the rest, so two different bad leaves of one nested
 * field answer alike with `<field>: Invalid input` (ISS-1069).
 * The SHAPE is `{ formErrors, fieldErrors }` keyed on the top-level field, which web-v2 renders
 * and every project route answers with; only the message carries the path.
 */
export function flatten(error: {
  issues: readonly { path: readonly PropertyKey[]; message: string }[];
}): {
  formErrors: string[];
  fieldErrors: Record<string, string[]>;
} {
  const formErrors: string[] = [];
  const fieldErrors: Record<string, string[]> = {};
  for (const issue of error.issues) {
    const [head, ...rest] = issue.path;
    if (head === undefined) {
      formErrors.push(issue.message);
      continue;
    }
    const key = String(head);
    const where = rest.length > 0 ? `${key}.${rest.join('.')}: ` : '';
    const bucket = fieldErrors[key] ?? [];
    bucket.push(`${where}${issue.message}`);
    fieldErrors[key] = bucket;
  }
  return { formErrors, fieldErrors };
}

export const badRequest = (details: unknown, code = 'BAD_REQUEST') =>
  new HTTPException(400, { message: 'Invalid input', cause: { code, details } });

export const notFound = (message = 'project not found') =>
  new HTTPException(404, { message, cause: { code: 'NOT_FOUND' } });

export const forbidden = (message: string) =>
  new HTTPException(403, { message, cause: { code: 'FORBIDDEN' } });

export const conflict = (code: string, message: string, details?: unknown) =>
  new HTTPException(409, { message, cause: details === undefined ? { code } : { code, details } });

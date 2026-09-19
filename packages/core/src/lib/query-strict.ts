import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';

function unrecognizedKeys(error: z.core.$ZodError<unknown>): string[] {
  const keys = new Set<string>();
  for (const issue of error.issues) {
    if (issue.code === 'unrecognized_keys') for (const key of issue.keys) keys.add(key);
  }
  return [...keys];
}

export function queryBadRequest<T>(
  schema: z.ZodObject<z.ZodRawShape>,
  error: z.core.$ZodError<T>,
): HTTPException {
  const unknown = unrecognizedKeys(error);
  const details = z.flattenError(error);
  if (unknown.length === 0) {
    return new HTTPException(400, {
      message: 'Invalid input',
      cause: { code: 'BAD_REQUEST', details },
    });
  }
  const accepted = Object.keys(schema.shape).sort();
  const named = unknown.map((key) => `\`${key}\``).join(', ');
  return new HTTPException(400, {
    message:
      `Unknown query parameter${unknown.length > 1 ? 's' : ''}: ${named}. ` +
      `This route takes: ${accepted.join(', ')}.`,
    cause: {
      code: 'UNKNOWN_QUERY_PARAMETER',
      details: { unknownParameters: unknown, accepted, ...details },
    },
  });
}

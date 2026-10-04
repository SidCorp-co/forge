import { HTTPException } from 'hono/http-exception';
import type { z } from 'zod';
import { jsonPointer, type Refusal } from './refusal.js';

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
  if (unknown.length === 0) {
    return new HTTPException(400, {
      message: 'Invalid input',
      cause: { code: 'BAD_REQUEST', details: error },
    });
  }
  const accepted = Object.keys(schema.shape).sort();
  const named = unknown.map((key) => `\`${key}\``).join(', ');
  const takes = `This route takes: ${accepted.join(', ')}.`;
  const rows: Refusal[] = [
    ...unknown.map((key) => ({
      code: 'UNKNOWN_QUERY_PARAMETER',
      path: jsonPointer([key]),
      detail: `\`${key}\` is not a query parameter of this route. ${takes}`,
    })),
    ...error.issues
      .filter((issue) => issue.code !== 'unrecognized_keys')
      .map((issue) => ({ code: 'BAD_REQUEST', path: jsonPointer(issue.path), detail: issue.message })),
  ];
  return new HTTPException(400, {
    message: `Unknown query parameter${unknown.length > 1 ? 's' : ''}: ${named}. ${takes}`,
    cause: { code: 'UNKNOWN_QUERY_PARAMETER', details: rows },
  });
}

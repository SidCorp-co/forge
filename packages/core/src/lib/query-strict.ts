import { HTTPException } from 'hono/http-exception';
import type { ZodType, z } from 'zod';
import { fieldsNamedAt } from './unknown-fields.js';
import { schemaRefusalWords, schemaRefused, wordedFlatten } from './zod-sentences.js';

/** The code a query parameter no route takes is refused with, on every route alike. */
export const UNKNOWN_QUERY_PARAMETER = 'UNKNOWN_QUERY_PARAMETER';

/** An issue a query's parse, or the gate in front of it, raised. */
type QueryIssueLike = {
  code?: string;
  path?: readonly PropertyKey[];
  message?: string;
  keys?: readonly string[];
};

/** The query keys an issue list names as not taken at the top level, in the order sent. */
export function strayKeys(issues: readonly QueryIssueLike[]): string[] {
  const keys = new Set<string>();
  for (const issue of issues) {
    if (issue.code !== 'unrecognized_keys' || (issue.path ?? []).length > 0) continue;
    for (const key of issue.keys ?? []) keys.add(key);
  }
  return [...keys];
}

function joined(names: readonly string[]): string {
  if (names.length === 0) return 'no query parameter';
  return names.length === 1
    ? (names[0] ?? '')
    : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

/**
 * A query refused in sentences, under `UNKNOWN_QUERY_PARAMETER` where a key is stray: each stray
 * key by name, the known keys near it, and every key the call takes, as the issue lists said first
 * (ISS-991) and every route says since ISS-1421 r19. Details carry the same sentences by field.
 */
export function queryRefused(
  issues: readonly QueryIssueLike[],
  schema: ZodType,
  query: unknown,
): HTTPException {
  const unknown = strayKeys(issues);
  // The gate and a strict schema can both name the same stray key: it is said once, first.
  const rest = issues.filter((i) => i.code !== 'unrecognized_keys' || (i.path ?? []).length > 0);
  const said =
    unknown.length > 0 ? [{ code: 'unrecognized_keys', path: [], keys: unknown }, ...rest] : rest;
  const words = {
    valuesAre: 'listed in details.accepted',
    input: query,
    fieldsAt: (path: readonly PropertyKey[]) => fieldsNamedAt(schema, path),
  };
  const { sentences, accepted } = schemaRefusalWords(said, words);
  const takes = fieldsNamedAt(schema, []).sort();
  if (unknown.length > 0) sentences.push(`It takes ${joined(takes)}.`);
  const empty = rest.flatMap((i) =>
    /^is empty[.:]/.test(i.message ?? '') ? [(i.path ?? []).map(String).join('.')] : [],
  );
  return new HTTPException(400, {
    message: sentences.join(' '),
    cause: {
      code: unknown.length > 0 ? UNKNOWN_QUERY_PARAMETER : 'BAD_REQUEST',
      details: {
        ...(unknown.length > 0 ? { unknownParameters: unknown, takes } : {}),
        ...(empty.length > 0 ? { emptyFields: empty } : {}),
        ...wordedFlatten(said, words),
        ...(accepted.length > 0
          ? { accepted: Object.fromEntries(accepted.map((a) => [a.field, a.values])) }
          : {}),
      },
    },
  });
}

/** A route's own query parse refused: a stray key as every route refuses one, the rest by field. */
export function queryBadRequest<T>(
  schema: z.ZodObject<z.ZodRawShape>,
  error: z.core.$ZodError<T>,
  query?: unknown,
): HTTPException {
  if (strayKeys(error.issues).length > 0) return queryRefused(error.issues, schema, query);
  return schemaRefused(error, schema, query);
}

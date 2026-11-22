// The success answers the contract declares (ISS-1412), split from openapi.ts, which describes the
// routes: every operation's answer is undeclared, but where a handler declares one
// (`middleware/declared-response.ts`) for the credential it answers.

import type { DeclaredResponse } from '../middleware/declared-response.js';

type JsonSchema = Record<string, unknown>;

export const UNDECLARED_RESPONSE =
  'Undeclared. forge-core holds no response schema for this route, so this contract does not describe what it answers.';

/**
 * The operation a declared answer belongs to: exactly its own path and method, so a door registered
 * for every method of a pattern answers the one route it names, never each route the pattern covers.
 */
export function answeredAt(
  response: DeclaredResponse | undefined,
  path: string,
): { key: string; response: DeclaredResponse; unmounted: string } | null {
  if (response === undefined) return null;
  const key = `${response.method} ${path}`;
  const unmounted = `${key}: a declared ${response.status} answer for a route that is not mounted`;
  return { key, response, unmounted };
}

/**
 * Each declared answer under its status. The declared body is the answer under its credential, and
 * every other caller's stays undeclared beside it, so the schema says what a client of that
 * credential reads and claims nothing about the rest.
 */
export function declaredAnswers(
  responses: readonly DeclaredResponse[],
  refusals: string[],
  schemaOf: (r: DeclaredResponse) => JsonSchema | string,
): Record<string, JsonSchema> {
  const out: Record<string, JsonSchema> = {};
  for (const r of responses) {
    const status = String(r.status);
    if (out[status] !== undefined) {
      refusals.push(`two declared ${status} answers, which this generator will not merge`);
      continue;
    }
    const schema = schemaOf(r);
    if (typeof schema === 'string') {
      refusals.push(`a declared ${status} answer with ${schema}`);
      continue;
    }
    out[status] = {
      description: `Under ${r.under}: ${r.description} Under any other credential: ${UNDECLARED_RESPONSE}`,
      content: {
        'application/json': {
          schema: {
            anyOf: [
              { ...schema, title: `Under ${r.under}` },
              { title: 'Under any other credential', description: UNDECLARED_RESPONSE },
            ],
          },
        },
      },
    };
  }
  return out;
}

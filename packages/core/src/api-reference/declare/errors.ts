import type { JsonSchema } from './schema.js';

/** The body `middleware/error.ts` writes for every refusal the API gives. */
export const ERROR_ENVELOPE_NAME = 'ForgeError';

export const ERROR_ENVELOPE: JsonSchema = {
  type: 'object',
  required: ['code', 'message'],
  properties: {
    code: { type: 'string', description: 'A stable name for what went wrong; branch on this.' },
    message: { type: 'string', description: 'What happened and what to do about it.' },
    details: { description: 'Structured detail for this code, where it has any.' },
  },
};

/** An error response naming the codes a status can carry and when each happens. */
export function errorResponse(
  codes: ReadonlyArray<{ readonly code: string; readonly when: string }>,
): JsonSchema {
  const names = [...new Set(codes.map((c) => c.code))].sort();
  const lines = codes
    .filter((c) => c.when !== '')
    .map((c) => `- \`${c.code}\`: ${c.when}`)
    .join('\n');
  return {
    description: lines === '' ? names.join(', ') : lines,
    content: {
      'application/json': {
        schema: {
          allOf: [
            { $ref: `#/components/schemas/${ERROR_ENVELOPE_NAME}` },
            { type: 'object', properties: { code: { enum: names } } },
          ],
        },
      },
    },
  };
}

const LIBRARY_DEFAULT_REFUSAL: JsonSchema = {
  description:
    'The input failed the schema and this validator has no hook, so the library answers with the failed parse.',
  content: {
    'application/json': {
      schema: {
        type: 'object',
        required: ['success', 'error'],
        properties: { success: { const: false }, error: {} },
      },
    },
  },
};

function jsonSchemaOf(response: JsonSchema): JsonSchema {
  const content = response.content as Record<string, { schema: JsonSchema }>;
  return content['application/json']?.schema ?? {};
}

/** One response that admits what either of two answers at the same status admits, with both descriptions. */
export function alongside(first: JsonSchema, second: JsonSchema): JsonSchema {
  return {
    description: `${String(first.description)}\n${String(second.description)}`,
    content: {
      'application/json': {
        schema: { anyOf: [jsonSchemaOf(first), jsonSchemaOf(second)] },
      },
    },
  };
}

/** A 400 answer that also admits the library's own refusal, for a route with one validator that has a hook and one that has none. */
export function withLibraryRefusal(hooked: JsonSchema | undefined): JsonSchema {
  return hooked ? alongside(hooked, LIBRARY_DEFAULT_REFUSAL) : LIBRARY_DEFAULT_REFUSAL;
}

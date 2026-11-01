// The components every operation's refusal answer points at: one problem-details body for every
// refusal and error, split from openapi.ts, which describes the routes.

import { PROBLEM_CONTENT_TYPE, REFUSAL_STATUSES } from '@forge/contracts/refusal';

type JsonSchema = Record<string, unknown>;

const REFUSAL_SCHEMA: JsonSchema = {
  type: 'object',
  required: ['code', 'path', 'detail'],
  properties: {
    code: { type: 'string' },
    path: {
      type: 'string',
      description: "A JSON pointer into the request, '' for the whole of it.",
    },
    detail: { type: 'string' },
  },
};

const PROBLEM_SCHEMA: JsonSchema = {
  type: 'object',
  description:
    'RFC 9457 problem details, one body for every refusal and error. `code` and `message` are ' +
    'extension members (RFC 9457 section 3.2) equal to `error.code` and `error.message`: a client ' +
    'reads either. `error.refusals` is ordered most relevant first; an error that is not a rule ' +
    'refusal carries one row at the request naming its sentence, and may carry `details`.',
  required: ['type', 'title', 'status', 'detail', 'code', 'message', 'error'],
  properties: {
    type: { type: 'string', description: 'urn:forge:refusal:<code>' },
    title: { type: 'string' },
    status: { type: 'integer' },
    detail: { type: 'string' },
    code: { type: 'string', description: 'Equal to error.code.' },
    message: { type: 'string', description: 'Equal to error.message.' },
    details: {},
    error: {
      type: 'object',
      required: ['code', 'message', 'refusals'],
      properties: {
        code: { type: 'string' },
        message: { type: 'string' },
        refusals: { type: 'array', minItems: 1, items: { $ref: '#/components/schemas/Refusal' } },
      },
    },
  },
};

export const COMPONENTS: JsonSchema = {
  schemas: { Refusal: REFUSAL_SCHEMA, Problem: PROBLEM_SCHEMA },
  responses: {
    Problem: {
      description:
        `Refused or failed. A refusal answers ${REFUSAL_STATUSES.join(', ')} by what the client ` +
        'should do: 400 fix the request, 403 stop, 404 not there for it, 409 re-read and retry, ' +
        '422 change what the rule names.',
      content: { [PROBLEM_CONTENT_TYPE]: { schema: { $ref: '#/components/schemas/Problem' } } },
    },
  },
};

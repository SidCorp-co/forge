import { z } from 'zod';
import { describeOperation, empty, fail, json } from '../api-reference/declare/describe.js';
import { tableRow } from '../api-reference/declare/rows.js';
import { notificationSilences } from '../db/schema.js';

export const silenceRowSchema = tableRow(notificationSilences);

export const listSilences = describeOperation({
  summary: 'List the caller’s silences that have not expired',
  responses: { 200: json(z.array(silenceRowSchema)) },
});

export const createSilence = describeOperation({
  summary: 'Silence a kind of notification until a deadline',
  description:
    'A silence names a type, a project or a resolution key, and ends at `expiresAt`, which must be in the future and at most seven days out.',
  responses: {
    201: json(silenceRowSchema, 'The silence'),
    400: fail('BAD_REQUEST', '`expiresAt` is not in the future or is more than seven days out'),
  },
});

export const endSilence = describeOperation({
  summary: 'End a silence now',
  description: 'The row stays, with its expiry set to the moment of the call.',
  responses: {
    204: empty(),
    404: fail('NOT_FOUND', 'The silence is not one the caller made'),
  },
});

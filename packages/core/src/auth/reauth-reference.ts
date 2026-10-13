import { z } from 'zod';
import { describeOperation, fail, json } from '../api-reference/describe.js';

export const reauthedSchema = z.object({ freshAuthAt: z.string() });

export const reauth = describeOperation({
  summary: 'Prove the password again, so the session counts as freshly authenticated',
  description:
    'The proof lasts the few minutes that routes asking for a fresh session accept. An account with no password gets the same 401 as a wrong one.',
  responses: {
    200: json(reauthedSchema, 'When the session was last freshly authenticated'),
    401: fail('INVALID_CREDENTIALS', 'the password is wrong, or the account has none'),
  },
});

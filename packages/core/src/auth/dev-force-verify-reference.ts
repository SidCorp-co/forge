import { z } from 'zod';
import { describeOperation, fail, json } from '../api-reference/declare/describe.js';

export const forceVerifySchema = z.object({ email: z.string().email() });

export const forcedSchema = z.object({ verified: z.literal(true), alreadyVerified: z.boolean() });

export const forceVerify = describeOperation({
  summary: 'Mark an allow-listed account as verified without its mail',
  description:
    'A development aid: answers 404 in production, and refuses any email that is not in `ADMIN_EMAILS`.',
  responses: {
    200: json(forcedSchema, 'The account is verified; `alreadyVerified` says it was before'),
    400: fail('BAD_REQUEST', 'the body is not JSON or carries no valid `email`'),
    403: fail('FORBIDDEN', 'the email is not in the allow-list'),
    404: fail({
      NOT_FOUND: 'the server runs in production',
      USER_NOT_FOUND: 'no account has this email',
    }),
  },
});

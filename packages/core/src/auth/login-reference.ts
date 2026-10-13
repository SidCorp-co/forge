import { z } from 'zod';
import { describeOperation, fail, json } from '../api-reference/describe.js';

export const loginAnswerSchema = z.object({
  token: z.string(),
  user: z.object({ id: z.string(), email: z.string(), emailVerified: z.boolean() }),
  emailVerificationRequired: z.boolean(),
});

export const login = describeOperation({
  summary: 'Sign in with an email and a password',
  description:
    'Answers a session token and sets two httpOnly cookies: the session cookie, and the refresh cookie scoped to `/api/auth`. The same 401 answers an unknown email, an account with no password and a wrong password.',
  responses: {
    200: json(loginAnswerSchema, 'The session token and who signed in'),
    401: fail('INVALID_CREDENTIALS', 'the email or the password is wrong'),
    403: fail('AGENT_CANNOT_LOGIN', 'the account is an agent, which signs in with its token'),
  },
});

import { z } from 'zod';
import { describeOperation, fail, json } from '../api-reference/declare/describe.js';
import { REFRESH_COOKIE_NAME } from './cookie-names.js';

/** The refresh token rides only in its httpOnly cookie. */
export const refreshCookieSchema = z.object({ [REFRESH_COOKIE_NAME]: z.string().optional() });

export const refreshedSchema = z.object({ token: z.string() });

export const refresh = describeOperation({
  summary: 'Trade the refresh cookie for a new session token',
  description:
    'Sets a new session cookie and a new refresh cookie, and the old refresh token stops working. A missing cookie answers the same 401 as a forged one.',
  responses: {
    200: json(refreshedSchema, 'The new session token'),
    401: fail({
      INVALID_REFRESH_TOKEN: 'no refresh cookie, or it matches no token',
      REFRESH_TOKEN_EXPIRED: 'the refresh token is past its expiry',
      REFRESH_TOKEN_REUSED:
        'the token was already used, so every refresh token of that user is retired',
    }),
    403: fail('AGENT_CANNOT_LOGIN', 'the token belongs to an agent account'),
  },
});

import { z } from 'zod';
import { describeOperation, fail, json, redirect } from '../api-reference/declare/describe.js';

export const verifyQuerySchema = z.object({ token: z.string().optional() });

/** The JSON body of a programmatic verification; the query token wins when both are sent. */
export const verifyBodySchema = z.object({ token: z.string().optional() });

export const verifiedSchema = z.object({ verified: z.literal(true) });

export const verifyFromEmail = describeOperation({
  summary: 'Verify an email address from the link in the verification mail',
  description:
    'Always a redirect to the web login: `?verified=1` on success, `?verify_error=invalid` or `?verify_error=expired` otherwise.',
  responses: { 302: redirect('To the web login, with the outcome in the query') },
});

export const verifyProgrammatically = describeOperation({
  summary: 'Verify an email address with a token sent in the query or the JSON body',
  responses: {
    200: json(verifiedSchema, 'The address is verified'),
    400: fail({
      INVALID_TOKEN: 'no token, or it matches no pending verification',
      TOKEN_EXPIRED: 'the token is past its expiry',
    }),
  },
});

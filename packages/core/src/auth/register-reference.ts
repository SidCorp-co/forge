import { z } from 'zod';
import { describeOperation, fail, json } from '../api-reference/declare/describe.js';

export const registeredSchema = z.object({ userId: z.string(), email: z.string() });

export const register = describeOperation({
  summary: 'Register an account with an email and a password',
  description:
    'Creates the user and their personal organization, then sends a verification email. A mail that fails to send does not undo the registration.',
  responses: {
    201: json(registeredSchema, 'The new account'),
    400: fail('WEAK_PASSWORD', 'the password is too easy to guess; `details` carries the advice'),
    409: fail({
      CONFLICT: 'the email is already registered',
      AGENT_ADDRESS_RESERVED: 'the address is on the domain Forge mints agent accounts on',
    }),
  },
});

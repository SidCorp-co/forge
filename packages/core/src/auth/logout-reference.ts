import { describeOperation, empty } from '../api-reference/declare/describe.js';

export const logout = describeOperation({
  summary: 'Sign out and retire every refresh token of the caller',
  description: 'Clears the session cookie and the refresh cookie.',
  responses: { 204: empty('Signed out') },
});

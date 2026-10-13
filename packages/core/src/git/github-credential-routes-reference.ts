import { z } from 'zod';
import { describeOperation, fail, json } from '../api-reference/declare/describe.js';

/** What git's credential helper reads back: the username, the installation token and when it dies. */
export const gitCredentialGrantSchema = z.object({
  username: z.string(),
  password: z.string(),
  expiresAt: z.string(),
});

export const askGitCredential = describeOperation({
  summary:
    "Mint a short-lived git token for one repository, for the runner's git credential helper",
  description:
    "Called once per git invocation by the device's credential helper. The grant is computed from the device's runners and the project's GitHub App binding on every call; nothing is stored.",
  responses: {
    200: json(gitCredentialGrantSchema, 'An installation token that reaches the one repository'),
    400: fail(
      undefined,
      'host and path are missing, the protocol is not https, or the path is not an owner/repo path',
    ),
    401: fail(undefined, 'the device is revoked'),
    404: fail(
      undefined,
      'no active GitHub App binding for the repository on any project the device runs',
    ),
    409: fail(
      undefined,
      'the App is not installed for the binding, or its connection is deactivated or holds no App credential',
    ),
  },
});

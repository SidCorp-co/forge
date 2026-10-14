import { z } from 'zod';
import { describeOperation, fail, json } from '../api-reference/declare/describe.js';

/** One checkout a box is asked to provision, with the credentials it needs to clone and push. */
export const provisionSchema = z.object({
  runnerId: z.string(),
  projectId: z.string(),
  slug: z.string(),
  repoPath: z.string().nullable(),
  branch: z.string().nullable(),
  repoUrl: z.string().nullable(),
  sshKeySource: z.string().nullable(),
  sshPublicKey: z.string().nullable(),
  sshPrivateKey: z.string().nullable(),
  githubAppCredential: z.boolean(),
  mcpCredential: z.string().nullable(),
});

export const listProvisions = describeOperation({
  summary:
    'List the project checkouts this device is asked to provision, with the credentials they need',
  description:
    'A bare array, because a deployed runner decodes only that. Rows that could not be built are left out and named in the `X-Forge-Provision-Failures` response header.',
  responses: {
    200: json(z.array(provisionSchema)),
    401: fail('UNAUTHENTICATED', 'the device is revoked'),
  },
});

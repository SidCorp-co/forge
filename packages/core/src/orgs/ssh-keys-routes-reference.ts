import { z } from 'zod';
import { describeOperation, empty, fail, json } from '../api-reference/declare/describe.js';
import { projectGitCredentialSources, workspaceSshKeyTypes } from '../db/schema.js';

export const orgParamSchema = z.object({ orgId: z.uuid() });
export const keyParamSchema = z.object({ orgId: z.uuid(), keyId: z.uuid() });

export const createSshKeySchema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('generate'),
    name: z.string().trim().min(1).max(200),
    note: z.string().trim().max(2000).nullable().optional(),
  }),
  z.object({
    mode: z.literal('provide'),
    name: z.string().trim().min(1).max(200),
    note: z.string().trim().max(2000).nullable().optional(),
    privateKey: z.string().min(1).max(20000),
  }),
]);

export const testSshKeySchema = z.object({ repoUrl: z.string().trim().min(1).max(2000) });

/** A pool key as every route shows it: never the private half. */
export const sshKeyViewSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  name: z.string(),
  note: z.string().nullable(),
  source: z.enum(projectGitCredentialSources),
  keyType: z.enum(workspaceSshKeyTypes),
  publicKey: z.string(),
  fingerprint: z.string().nullable(),
  createdAt: z.string(),
  usedByProjects: z.array(z.object({ id: z.string(), slug: z.string(), name: z.string() })),
});

export const sshKeyListSchema = z.array(sshKeyViewSchema);

export const sshConnectionTestSchema = z.object({
  ok: z.boolean(),
  code: z.enum([
    'authenticated',
    'auth_denied',
    'host_unreachable',
    'not_found',
    'timeout',
    'error',
  ]),
  message: z.string(),
  headSha: z.string().optional(),
});

const NO_ORG = 'the organization does not exist';
const VAULT = 'the secret vault is not configured on this server';

export const listSshKeys = describeOperation({
  summary: 'List the SSH keys an organization holds, with the projects using each',
  responses: {
    200: json(sshKeyListSchema),
    403: fail('FORBIDDEN', 'the caller is not a member of the organization'),
    404: fail('NOT_FOUND', NO_ORG),
  },
});

export const createSshKey = describeOperation({
  summary: 'Generate an SSH key for the organization, or store one the caller provides',
  description: 'The private half is kept in the vault and never sent back.',
  responses: {
    201: json(sshKeyViewSchema, 'The key, as the listing shows it'),
    400: fail('INVALID_PRIVATE_KEY', 'the provided key is malformed or protected by a passphrase'),
    403: fail('FORBIDDEN', 'the caller is not an admin of the organization'),
    404: fail('NOT_FOUND', NO_ORG),
    409: fail('DUPLICATE_FINGERPRINT', 'the organization already holds this key'),
    500: fail({
      KEYPAIR_FAILED: 'the key pair could not be built',
      INSERT_FAILED: 'the insert returned no row',
    }),
    503: fail('VAULT_NOT_CONFIGURED', VAULT),
  },
});

export const deleteSshKey = describeOperation({
  summary: 'Delete an SSH key no project uses',
  responses: {
    204: empty('Deleted'),
    403: fail('FORBIDDEN', 'the caller is not an admin of the organization'),
    404: fail('NOT_FOUND', `${NO_ORG}, or it holds no such key`),
    409: fail('KEY_IN_USE', 'projects still use the key; `details.referencedBy` lists them'),
  },
});

export const testSshKey = describeOperation({
  summary: 'Check that a key can reach a repository over SSH',
  description:
    'A refused or unreachable remote is an answer with `ok: false`, not an error. The URL must be an SSH remote that resolves to public addresses only.',
  responses: {
    200: json(sshConnectionTestSchema, 'What the probe found'),
    400: fail({
      INVALID_TRANSPORT: 'the URL is not an SSH clone URL',
      SSRF_BLOCKED: 'the host resolves to a private or reserved address',
      HOST_UNRESOLVED: 'the host cannot be resolved',
    }),
    403: fail('FORBIDDEN', 'the caller is not a member of the organization'),
    404: fail('NOT_FOUND', `${NO_ORG}, or it holds no such key`),
    500: fail('DECRYPT_FAILED', 'the stored key cannot be decrypted, as after a vault key change'),
    503: fail('VAULT_NOT_CONFIGURED', VAULT),
  },
});

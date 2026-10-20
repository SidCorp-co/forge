import { z } from 'zod';
import { describeOperation, empty, fail, json } from '../api-reference/declare/describe.js';
import { projectGitCredentialSources, workspaceSshKeyTypes } from '../db/schema.js';

/** A pool key as every surface shows it: the public half only, never the private key. */
const sshKeyViewSchema = z.object({
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

/** What the project reaches its repository with: the org-pool key it picked, or nothing yet. */
export const projectGitAccessSchema = z.union([
  z.object({ configured: z.literal(false) }),
  z.object({
    configured: z.literal(true),
    repoUrl: z.string().nullable(),
    key: sshKeyViewSchema,
  }),
]);

export const sshConnectionTestSchema = z.object({
  ok: z.boolean(),
  code: z.enum([
    'authenticated',
    'auth_denied',
    'key_unreadable',
    'host_unreachable',
    'not_found',
    'timeout',
    'error',
  ]),
  message: z.string(),
  headSha: z.string().optional(),
  diagnostics: z
    .object({ hostSaid: z.string().optional() })
    .optional()
    .describe("What the git host or ssh said, its paths hidden; the message is Forge's own words"),
});

const NOT_FOUND = 'the project does not exist';

export const readGitCredential = describeOperation({
  summary: "Read which of the org's deploy keys the project reaches its repository with",
  description: 'A project that has picked none, or whose key is gone, answers `configured: false`.',
  responses: {
    200: json(projectGitAccessSchema, 'The key the project uses, if any'),
    403: fail('FORBIDDEN', 'the caller is not a member of the project'),
    404: fail('NOT_FOUND', NOT_FOUND),
  },
});

export const pickGitCredential = describeOperation({
  summary: "Choose one of the org's deploy keys for the project",
  description:
    'The key must belong to the same org as the project. Replaces any key chosen before.',
  responses: {
    201: json(projectGitAccessSchema, 'The key now in use'),
    400: fail('WRONG_ORG', "the key does not belong to the project's organization"),
    403: fail('FORBIDDEN', 'the caller is not a project admin'),
    404: fail('NOT_FOUND', NOT_FOUND),
  },
});

export const testGitCredential = describeOperation({
  summary: "Test the project's deploy key against its repository",
  description:
    'Runs `git ls-remote` over SSH with the stored key. A refused or unreachable remote, and a stored key Forge cannot decrypt (`key_unreadable`), is a 200 with `ok: false`; only a project that cannot be tested is an error.',
  responses: {
    200: json(sshConnectionTestSchema, 'The outcome of the connection test'),
    400: fail('NEEDS_SSH_URL', 'the project has no SSH clone URL to test against'),
    403: fail('FORBIDDEN', 'the caller is not a member of the project'),
    404: fail({
      NOT_FOUND: NOT_FOUND,
      NOT_CONFIGURED: 'the project has no deploy key',
    }),
    503: fail('VAULT_NOT_CONFIGURED', 'the server has no secret vault'),
  },
});

export const removeGitCredential = describeOperation({
  summary: 'Stop using a deploy key for the project',
  description: 'The key itself stays in the org pool.',
  responses: {
    204: empty('The project uses no key'),
    403: fail('FORBIDDEN', 'the caller is not a project admin'),
    404: fail('NOT_FOUND', NOT_FOUND),
  },
});

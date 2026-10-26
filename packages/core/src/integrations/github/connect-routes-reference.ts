import { z } from 'zod';
import { describeOperation, fail, json, redirect } from '../../api-reference/declare/describe.js';
import { declaresInput, zValidator } from '../../api-reference/declare/validator.js';
import { noRoleOnProject, notProjectAdmin, onProject, vaultMissing } from '../routes-reference.js';

/** Which org owns the App on github.com (`org`) and which Forge org owns the connection (`orgId`). */
export const connectQuerySchema = z.object({
  org: z.string().optional(),
  orgId: z.uuid().optional(),
});

export const repositoriesQuerySchema = z.object({ connectionId: z.uuid() });

/**
 * GitHub hands the code and the state back on the first redirect, the installation on the second.
 * Both take any other key: GitHub shapes these redirects and adds keys of its own (`setup_action`),
 * so a key Forge does not read is GitHub's, never a caller's slip (ISS-1421 r19).
 */
export const manifestCallbackQuerySchema = z.looseObject({
  code: z.string().optional(),
  state: z.string().optional(),
});

export const installedQuerySchema = z.looseObject({
  installation_id: z.string().optional(),
  state: z.string().optional(),
});

export const manifestSchema = z.object({
  postUrl: z.string(),
  state: z.string(),
  manifest: z.record(z.string(), z.unknown()),
});

export const repositoriesSchema = z.object({
  repositories: z.array(
    z.object({
      installationId: z.number(),
      account: z.string(),
      owner: z.string(),
      repo: z.string(),
      fullName: z.string(),
    }),
  ),
  truncated: z.boolean(),
});

export const startGithubConnect = onProject(
  describeOperation({
    summary: 'Begin creating a GitHub App for the project: the manifest to post to GitHub',
    description:
      'Answers the address to post the manifest to, the signed `state` that ties the return to this caller and project, and the manifest itself. `org` makes GitHub create the App under that organization.',
    responses: {
      200: json(manifestSchema),
      403: fail({
        FORBIDDEN: 'the caller is not a project admin',
        ORG_ADMIN_REQUIRED: 'the project belongs to an org and the caller is not its admin',
      }),
      404: fail('NOT_FOUND', 'no such project, or the caller cannot see it'),
      409: fail({
        ORG_MISMATCH: "`orgId` is not the project's own org, so the App would be owned by another",
        REMOVED_CONNECTION_OTHER_OWNER:
          "the project's GitHub binding names a removed connection the new App would not belong to",
        ALREADY_EXISTS: 'a GitHub binding is switched on for the project over a live connection',
      }),
      503: vaultMissing,
    },
  }),
);

export const listGithubRepositories = onProject(
  describeOperation({
    summary:
      'The repositories every installation of a GitHub App reaches, for the repository picker',
    responses: {
      200: json(repositoriesSchema),
      400: fail('BAD_REQUEST', '`connectionId` is missing, or is not a GitHub App'),
      403: notProjectAdmin,
      404: fail({
        NOT_FOUND: 'no such project, or the caller cannot see it',
        CONNECTION_NOT_REACHABLE: 'the connection does not exist, or the caller cannot reach it',
      }),
      409: fail({
        GITHUB_APP_UNFINISHED:
          'the connection is on and holds no App: creating it on GitHub was never finished',
        CONNECTION_REMOVED:
          'the connection was removed, so it holds no App until one is installed again',
      }),
    },
  }),
);

export const githubManifestCallback = describeOperation({
  summary: 'GitHub returns here after the App is created; the App is stored and bound',
  description:
    'A browser redirect, so it carries the operator session. Redirects to the new App installation page, or to the project integrations settings where GitHub named none.',
  responses: {
    302: redirect('To where the App is installed, or the integrations settings of the project'),
    400: fail(
      'BAD_REQUEST',
      '`code` or `state` is missing, the state is invalid, expired or was issued for another user',
    ),
    403: noRoleOnProject,
    404: fail(
      'NOT_FOUND',
      'the project the state names does not exist, or the caller cannot see it',
    ),
    409: fail(
      'ALREADY_EXISTS',
      'GitHub was switched on for the project while the App was created; the App is stored, kept off',
    ),
    503: vaultMissing,
  },
});

export const githubInstalled = describeOperation({
  summary: 'GitHub returns here after the App is installed; the installation is recorded',
  description:
    'A browser redirect. With `state` it finds the project binding from it, without it the binding that owns the installation.',
  responses: {
    302: redirect('To the integrations settings of the project'),
    400: fail(
      'BAD_REQUEST',
      '`installation_id` is missing or not positive, or the state is invalid, expired or was issued for another user',
    ),
    403: notProjectAdmin,
    404: fail('NOT_FOUND', 'no GitHub binding is waiting for this installation'),
  },
});

export const declaresConnectQuery = zValidator('query', connectQuerySchema);
export const declaresRepositoriesQuery = zValidator('query', repositoriesQuerySchema);
export const declaresManifestCallbackQuery = declaresInput('query', manifestCallbackQuerySchema);
export const declaresInstalledQuery = declaresInput('query', installedQuerySchema);

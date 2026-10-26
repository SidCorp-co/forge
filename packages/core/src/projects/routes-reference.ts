import { z } from 'zod';
import { describeOperation, empty, fail, json } from '../api-reference/declare/describe.js';
import { tableRow } from '../api-reference/declare/rows.js';
import {
  devicePlatforms,
  deviceStatuses,
  orgMemberRoles,
  projectMemberRoles,
  projects,
  releaseCrossings,
} from '../db/schema.js';
import { pipelineConfigSchema } from '../pipeline/pipeline-config-schema.js';
import { pluginDesignationSchema } from '../plugins/designation.js';

const projectRow = tableRow(projects);
/** The project's checkout hint, answered under the name the API has always given it (ISS-1236). */
const repoPathField = z
  .string()
  .nullable()
  .describe(
    "The path offered when a device is bound to this project. A device's own checkout is its runner binding's.",
  );
const roleSchema = z.enum(projectMemberRoles);
const orgRoleSchema = z.enum(orgMemberRoles);

/** A jsonb column the table types as `unknown`: the schema carries the shape its writers keep. */
const jsonObjectOrNull = (what: string) =>
  z.unknown().meta({ type: ['object', 'null'], description: what });

const releaseChainSchema = z.array(
  z.object({ branch: z.string(), from: z.enum(releaseCrossings).optional() }),
);

/** The three names reads keep answering, derived from `releaseChain` until forge-plugin stops asking. */
const retiredReleaseAxesShape = {
  releaseModel: z.enum(['none', 'promote', 'publish']),
  liveBranch: z.string().nullable(),
  releaseStrategy: z.enum(releaseCrossings).nullable(),
};

const agentConfigSchema = jsonObjectOrNull(
  "The project's agent configuration, one key per setting: pipelineConfig, plugins, personaStyle, systemPrompt, rocketChatAnswerMode and categories",
);
const environmentsSchema = jsonObjectOrNull(
  'The preview and live sides, test credentials and limits; `GET /api/projects/:id/environments` reads it as a document',
);

/** `?archived=1` or `?archived=true` brings archived projects into the list. */
export const listProjectsQuerySchema = z.object({ archived: z.string().optional() });

export const createdProjectSchema = projectRow.pick({
  id: true,
  slug: true,
  name: true,
  orgId: true,
  createdBy: true,
  createdAt: true,
});

export const projectListSchema = z.array(
  projectRow
    .pick({
      id: true,
      slug: true,
      name: true,
      orgId: true,
      createdBy: true,
      issuePrefix: true,
      archivedAt: true,
      createdAt: true,
    })
    .extend({
      orgName: z.string(),
      orgIsPersonal: z.boolean(),
      role: roleSchema.nullable(),
      orgRole: orgRoleSchema.nullable(),
    }),
);

export const projectDetailSchema = projectRow
  .pick({
    id: true,
    slug: true,
    name: true,
    orgId: true,
    createdBy: true,
    description: true,
    kind: true,
    repoUrl: true,
    workspaceSetup: true,
    baseBranch: true,
    defaultDeviceId: true,
    issuePrefix: true,
    archivedAt: true,
    createdAt: true,
  })
  .extend({
    ...retiredReleaseAxesShape,
    repoPath: repoPathField,
    releaseChain: releaseChainSchema,
    agentConfig: agentConfigSchema,
    environments: environmentsSchema,
    role: roleSchema.nullable(),
    orgRole: orgRoleSchema.nullable(),
    members: z.array(z.object({ userId: z.string(), role: roleSchema })),
    labels: z.array(z.object({ id: z.string(), name: z.string(), color: z.string() })),
    devicePool: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        platform: z.enum(devicePlatforms),
        status: z.enum(deviceStatuses),
        lastSeenAt: z.date().nullable(),
        runnerId: z.string(),
      }),
    ),
  });

export const patchedProjectSchema = projectRow
  .pick({
    id: true,
    slug: true,
    name: true,
    orgId: true,
    createdBy: true,
    description: true,
    kind: true,
    repoUrl: true,
    workspaceSetup: true,
    baseBranch: true,
    defaultDeviceId: true,
    issuePrefix: true,
    createdAt: true,
  })
  .extend({
    ...retiredReleaseAxesShape,
    repoPath: repoPathField,
    releaseChain: releaseChainSchema,
    agentConfig: agentConfigSchema,
    environments: environmentsSchema,
  });

export const archivedProjectSchema = projectRow.pick({
  id: true,
  slug: true,
  name: true,
  orgId: true,
  createdBy: true,
  archivedAt: true,
  createdAt: true,
});

export const pipelineConfigReadSchema = z.object({ pipelineConfig: pipelineConfigSchema });

export const pluginsWrittenSchema = z.object({ plugins: z.array(pluginDesignationSchema) });

export const branchConfigSchema = z.object({
  baseBranch: z.string().nullable(),
  targetBranch: z.string().nullable(),
  liveBranch: z.string().nullable(),
});

const NOT_A_MEMBER = fail('FORBIDDEN', 'the caller is not a member of the project');
const NEEDS_ORG_ADMIN = fail('FORBIDDEN', 'the caller is not an org owner or admin');
const NO_PROJECT = fail('NOT_FOUND', 'the project does not exist');

export const listProjects = describeOperation({
  summary: 'List the projects the caller can see',
  description:
    'A project is visible to its members and to the owners and admins of its org. Archived projects are left out unless `archived` is `1` or `true`. No row carries the webhook secret.',
  responses: { 200: json(projectListSchema, 'The visible projects, ordered by id') },
});

export const createNewProject = describeOperation({
  summary: "Create a project, owned by one of the caller's orgs",
  description:
    "With no `orgId` the project goes to the caller's personal org. The caller becomes its admin.",
  responses: {
    201: json(createdProjectSchema, 'The new project'),
    403: fail('FORBIDDEN', 'the caller is not a member of the org named by `orgId`'),
    404: fail('NOT_FOUND', 'the org named by `orgId` does not exist'),
    409: fail('SLUG_TAKEN', 'another project has this slug'),
    500: fail('PERSONAL_ORG_MISSING', 'the caller has no personal org to put the project in'),
  },
});

export const getProject = describeOperation({
  summary: 'Read one project with its members, labels and runner devices',
  description:
    '`releaseModel`, `liveBranch` and `releaseStrategy` are derived from `releaseChain` and answered for readers that have not moved to it. The webhook secret is not answered: the inbound webhook check is its one reader.',
  responses: {
    200: json(projectDetailSchema, 'The project'),
    403: NOT_A_MEMBER,
    404: NO_PROJECT,
  },
});

export const patchProject = describeOperation({
  summary: "Change a project's settings",
  description:
    'Needs an org owner or admin, not only a project admin. Moving the project with `orgId` also needs owner or admin of the target org. `agentConfig`, `environments`, `stateContext` and the retired release names are refused by name, each pointing at the route that now owns it. `baseBranch` and `releaseChain` must agree on where work merges. A write that would strand work already under way — emptying the release chain while issues wait for a release, or a kind change that un-counts a merge mark — is refused by name.',
  responses: {
    200: json(patchedProjectSchema, 'The project after the change'),
    400: fail({
      ENVIRONMENTS_MOVED:
        '`environments` was sent: it is written through `PATCH /api/projects/:id/environments`',
      RELEASE_CHAIN_BASE_MISMATCH: 'the release chain starts on a branch other than `baseBranch`',
      REPO_PATH_NOT_ABSOLUTE: '`repoPath` is not an absolute path, so nothing was saved',
      BAD_REQUEST: 'the issue prefix is not a valid prefix',
    }),
    403: NEEDS_ORG_ADMIN,
    404: fail('NOT_FOUND', 'the project, or the org named by `orgId`, does not exist'),
    409: fail({
      ISSUE_PREFIX_TAKEN: 'another project holds the issue prefix, for good',
      RELEASE_CHAIN_STRANDS_WORK:
        'the write empties the release chain while issues wait at `awaiting_release`; `details.issues` names them',
      PROJECT_KIND_STRANDS_WORK:
        "the kind change would make an unclosed issue's merge mark stop counting as a landing; `details.issues` names them",
    }),
  },
});

export const deleteProject = describeOperation({
  summary: 'Delete a project and everything it owns',
  description: 'Permanent. Archive the project to take it out of use without deleting it.',
  responses: { 204: empty('The project is deleted'), 403: NEEDS_ORG_ADMIN, 404: NO_PROJECT },
});

export const archiveProject = describeOperation({
  summary: 'Archive a project',
  description:
    'Idempotent and non-destructive: nothing the project owns is touched. An archived project leaves the default list and is no longer dispatched new automatic work.',
  responses: {
    200: json(archivedProjectSchema, 'The archived project'),
    403: NEEDS_ORG_ADMIN,
    404: NO_PROJECT,
  },
});

export const unarchiveProject = describeOperation({
  summary: 'Bring an archived project back',
  responses: {
    200: json(archivedProjectSchema, 'The project, no longer archived'),
    403: NEEDS_ORG_ADMIN,
    404: NO_PROJECT,
  },
});

export const getPipelineConfig = describeOperation({
  summary: "Read the project's pipeline configuration, with defaults filled in",
  description:
    'Keys the configuration no longer has are dropped from the answer. Write it with `PATCH /api/projects/:id/pipeline-config`.',
  responses: {
    200: json(pipelineConfigReadSchema, 'The pipeline configuration'),
    403: NOT_A_MEMBER,
    404: fail({
      FEATURE_OFF: 'pipeline control is switched off on this server',
      NOT_FOUND: 'the project does not exist',
    }),
  },
});

export const patchPlugins = describeOperation({
  summary: "Replace the project's plugin designations",
  description: 'The whole list is replaced; `null` clears it.',
  responses: {
    200: json(pluginsWrittenSchema, 'The designations now stored'),
    403: NEEDS_ORG_ADMIN,
    404: NO_PROJECT,
  },
});

export const getBranchConfig = describeOperation({
  summary: 'Read the branches one issue is cut from, targets and lands on',
  description: "An issue's own override, where it has one, wins over the project's branches.",
  responses: {
    200: json(branchConfigSchema, 'The resolved branches'),
    403: NOT_A_MEMBER,
    404: fail('NOT_FOUND', 'the project, or the issue in it, does not exist'),
  },
});

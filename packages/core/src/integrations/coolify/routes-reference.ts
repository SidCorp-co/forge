import { z } from 'zod';
import { describeOperation, fail, json } from '../../api-reference/declare/describe.js';
import { deployStages, integrationDeliveryStatuses } from '../../db/schema.js';
import {
  noRoleOnProject,
  noSuchBinding,
  notProjectAdmin,
  onBinding,
  onProject,
} from '../routes-reference.js';

export const deployBodySchema = z
  .object({
    issueId: z.uuid().optional(),
    pipelineRunId: z.uuid().optional(),
    integrationId: z.uuid().optional(),
  })
  .strict();

export const cancelBodySchema = z
  .object({
    integrationId: z.uuid().optional(),
    deploymentUuid: z.string().min(1).max(200).optional(),
  })
  .strict();

export const rollbackBodySchema = z
  .object({
    integrationId: z.uuid().optional(),
    resourceUuid: z.string().min(1).max(200).optional(),
    commit: z.string().min(1).max(200),
  })
  .strict();

export const applicationsBodySchema = z.union([
  z.object({ integrationId: z.uuid() }).strict(),
  z.object({ baseUrl: z.string().url().max(500), apiToken: z.string().min(8).max(2000) }).strict(),
]);

/** The filters a read takes: every key is optional and an empty one is ignored. */
export const integrationQuerySchema = z.object({ integrationId: z.string().optional() });
export const rollbackImagesQuerySchema = integrationQuerySchema.extend({
  resourceUuid: z.string().optional(),
});

const stagesSchema = z.array(z.enum(deployStages));

const integrationsSchema = z.object({
  integrations: z.array(
    z.object({
      id: z.string(),
      stages: stagesSchema,
      targets: z.array(z.object({ id: z.string(), label: z.string(), resourceUuid: z.string() })),
      lastHealthStatus: z.string().nullable(),
      breakerOpen: z.boolean(),
    }),
  ),
});

const deliveriesSchema = z.object({
  deliveries: z.array(
    z.object({
      integrationId: z.string(),
      stages: stagesSchema,
      targetId: z.string().nullable(),
      targetLabel: z.string().nullable(),
      deploymentUuid: z.string().nullable(),
      status: z.enum(integrationDeliveryStatuses).nullable(),
      breakerOpen: z.boolean(),
      createdAt: z.date().nullable(),
    }),
  ),
});

const dispatchedSchema = z.object({
  dispatched: z.boolean(),
  pendingHumanConfirm: z.boolean(),
  integrationIds: z.array(z.string()),
  reason: z.string().optional(),
});

const controlSchema = z.object({
  integrationId: z.string(),
  performed: z.boolean(),
  pendingHumanConfirm: z.boolean(),
  deploymentUuid: z.string().nullable(),
  detail: z.string().optional(),
});

const rollbackImagesSchema = z.object({
  integrationId: z.string(),
  resourceUuid: z.string(),
  targetLabel: z.string(),
  current: z.string().nullable(),
  images: z.array(
    z.object({ tag: z.string(), createdAt: z.string().nullable(), isCurrent: z.boolean() }),
  ),
});

const applicationSchema = z.object({
  uuid: z.string(),
  name: z.string().nullable(),
  fqdn: z.string().nullable(),
  gitRepository: z.string().nullable(),
  gitBranch: z.string().nullable(),
  gitCommitSha: z.string().nullable(),
  status: z.string().nullable(),
});

const applicationsSchema = z.object({ applications: z.array(applicationSchema) });

const targetsSchema = z.object({
  integrationId: z.string(),
  targets: z.array(
    applicationSchema.extend({ targetId: z.string(), label: z.string(), found: z.boolean() }),
  ),
});

const confirmedSchema = z.object({
  confirmed: z.boolean(),
  runId: z.string().nullable(),
  integrationId: z.string(),
});

export {
  applicationsSchema,
  confirmedSchema,
  controlSchema,
  deliveriesSchema,
  dispatchedSchema,
  integrationsSchema,
  rollbackImagesSchema,
  targetsSchema,
};

const commandRefused = fail(
  'BAD_REQUEST',
  'the project has no active Coolify integration (or several and none was named), or Coolify refused the action',
);
const coolifyAnswered = fail(
  'COOLIFY_API_ERROR',
  'Coolify answered with an error status, which the message names',
);

export const listCoolify = onProject(
  describeOperation({
    summary: "The project's active Coolify deploy integrations and their targets",
    responses: { 200: json(integrationsSchema), 403: noRoleOnProject, 404: noSuchBinding },
  }),
);

export const readCoolifyStatus = onProject(
  describeOperation({
    summary: 'The last deploy of each Coolify target of the project',
    responses: {
      200: json(deliveriesSchema),
      400: commandRefused,
      403: noRoleOnProject,
      404: noSuchBinding,
      502: coolifyAnswered,
    },
  }),
);

export const deployCoolify = onProject(
  describeOperation({
    summary: 'Deploy through the project Coolify integration',
    description:
      'With `pipelineRunId` of an open release batch, deploys that release and takes the environment lock; with `issueId`, the issue latest run; with neither, the one active integration. A live stage waits for a person unless the project deploys production by itself.',
    responses: {
      200: json(dispatchedSchema, 'Whether anything was dispatched, and why not where it was not'),
      400: fail(
        'BAD_REQUEST',
        'the body does not fit, no integration is named where several are active, the run is not an open release batch of the project, the release run announced no method, or the environment is locked by another release',
      ),
      403: fail('FORBIDDEN', 'the caller is below the project member role'),
      404: noSuchBinding,
      502: coolifyAnswered,
    },
  }),
);

export const cancelCoolify = onProject(
  describeOperation({
    summary: 'Cancel a deployment the integration started',
    description:
      'Without `deploymentUuid`, cancels the one its last outbound delivery recorded. Against a live stage it answers `pendingHumanConfirm` and does nothing.',
    responses: {
      200: json(controlSchema),
      400: fail(
        'BAD_REQUEST',
        'the body does not fit, no integration is named where several are active, there is no deployment to cancel, or Coolify refused',
      ),
      403: fail('FORBIDDEN', 'the caller is below the project member role'),
      404: noSuchBinding,
      502: coolifyAnswered,
    },
  }),
);

export const rollbackCoolify = onProject(
  describeOperation({
    summary: 'Roll a Coolify target back to an image tag it still lists',
    description:
      'Refused by name for a tag Coolify no longer lists. Against a live stage it answers `pendingHumanConfirm` and does nothing.',
    responses: {
      200: json(controlSchema),
      400: fail(
        'BAD_REQUEST',
        'the body does not fit, the target is not bound, the tag is not listed, or Coolify refused',
      ),
      403: fail('FORBIDDEN', 'the caller is below the project member role'),
      404: noSuchBinding,
      502: coolifyAnswered,
    },
  }),
);

/** A read of Coolify that got no answer Forge could use, named: 424, which Cloudflare passes through. */
const coolifyReadFailed = fail({
  COOLIFY_API_ERROR: 'Coolify refused the read, which the message names',
  COOLIFY_ANSWER_NOT_JSON: 'Coolify answered something that is not JSON',
  COOLIFY_UNREACHABLE: 'Forge could not connect to Coolify',
});

export const readRollbackImages = onProject(
  describeOperation({
    summary: 'The image tags a Coolify target can be rolled back to',
    responses: {
      200: json(rollbackImagesSchema),
      400: commandRefused,
      403: noRoleOnProject,
      404: noSuchBinding,
      424: coolifyReadFailed,
      502: coolifyAnswered,
    },
  }),
);

export const listCoolifyApplications = onProject(
  describeOperation({
    summary: 'The Coolify applications a credential can see, for the target picker',
    description:
      'Give `integrationId` to use the stored credential, or `baseUrl` and `apiToken` before anything is saved. At most 500 applications.',
    responses: {
      200: json(applicationsSchema),
      403: noRoleOnProject,
      404: fail('NOT_FOUND', 'the integration is not a Coolify binding of this project'),
      409: fail('MISSING_CREDENTIALS', 'the stored connection has no base url or api token'),
      424: coolifyReadFailed,
    },
  }),
);

export const readTargets = onProject(
  describeOperation({
    summary: 'Each bound Coolify target with the identity Coolify reports for it',
    responses: {
      200: json(targetsSchema),
      400: commandRefused,
      403: noRoleOnProject,
      404: noSuchBinding,
      424: coolifyReadFailed,
    },
  }),
);

export const confirmProdDeploy = onBinding(
  describeOperation({
    summary: 'Confirm the production deploy a release is waiting on',
    responses: {
      200: json(confirmedSchema, 'Whether a pending deploy was confirmed and queued'),
      400: fail(
        'NOT_LIVE_BINDING',
        'the binding carries no live stage, so no production deploy awaits a person',
      ),
      403: notProjectAdmin,
      404: noSuchBinding,
      409: fail(
        'DEPLOY_ENVIRONMENT_LOCKED',
        'another release holds the environment, so the confirmation can be pressed again',
      ),
    },
  }),
);

import { z } from 'zod';
import { describeOperation, fail, json } from '../api-reference/declare/describe.js';
import { pipelineConfigSchema } from '../pipeline/pipeline-config-schema.js';
import { environmentsPatchSchema } from './environments.js';

export const pipelineConfigAnswerSchema = z.object({ pipelineConfig: pipelineConfigSchema });

export const pipelineConfigWrittenSchema = pipelineConfigAnswerSchema.extend({
  warnings: z.array(z.string()),
});

export const environmentsReadSchema = z.object({
  environments: z.record(z.string(), z.unknown()),
});

export const environmentsWrittenSchema = z.object({ environments: environmentsPatchSchema });

const NEEDS_ORG_ADMIN = fail('FORBIDDEN', 'the caller is not an org owner or admin');
const NOT_A_MEMBER = fail('FORBIDDEN', 'the caller is not a member of the project');

export const writePipelineConfig = describeOperation({
  summary: "Change the project's pipeline configuration, as a patch against what the caller read",
  description:
    'The body is `{ base, patch }`: `patch` holds only the keys being changed (`null` deletes one) and `base` is the `pipelineConfig` that `GET /api/projects/:id/pipeline-config` answered. The write is applied whole or refused whole. A bare document is refused.',
  responses: {
    200: json(pipelineConfigWrittenSchema, 'The merged configuration, and any advisories'),
    400: fail({
      CONFIG_PATCH_SHAPE: 'the body is not `{ base, patch }`',
      CONFIG_CONFLICT: 'the merged configuration breaks a rule the schema holds across keys',
      OPEN_LOCKED_ON: 'the patch disables the `open` stage',
      STAGE_POOL_UNKNOWN_RUNNER: 'a stage runner pool names a device with no runner on the project',
    }),
    403: NEEDS_ORG_ADMIN,
    404: fail({
      FEATURE_OFF: 'pipeline control is switched off on this server',
      NOT_FOUND: 'the project does not exist',
    }),
    409: fail({
      CONFIG_STALE: 'a key the patch writes changed since `base` was read',
      STAGE_HAS_ISSUES: 'the patch disables a stage while issues are at it',
    }),
  },
});

export const getEnvironments = describeOperation({
  summary: "Read the project's environments: preview and live sides, test credentials and limits",
  responses: {
    200: json(environmentsReadSchema, 'The stored environments document'),
    403: NOT_A_MEMBER,
    404: fail('NOT_FOUND', 'the project does not exist'),
  },
});

export const writeEnvironments = describeOperation({
  summary: "Change the project's environments, as a patch against what the caller read",
  description:
    'The body is `{ base, patch }`, as for the pipeline configuration: `patch` holds only the keys being changed (`null` deletes one) and `base` is what `GET /api/projects/:id/environments` answered. The write is applied whole or refused whole.',
  responses: {
    200: json(environmentsWrittenSchema, 'The merged environments'),
    400: fail({
      ENVIRONMENTS_WRITE_SHAPE: 'the body is not `{ base, patch }`',
      ENVIRONMENTS_INVALID:
        'the merged environments are not valid, or the credentials the patch writes hold a row with no password or a second row for a label or login already listed; `details.conflicts` names each path and its `rule`',
    }),
    403: NEEDS_ORG_ADMIN,
    404: fail('NOT_FOUND', 'the project does not exist'),
    409: fail('ENVIRONMENTS_STALE', 'a key the patch writes changed since `base` was read'),
  },
});

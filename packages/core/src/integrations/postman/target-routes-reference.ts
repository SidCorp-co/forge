import { z } from 'zod';
import { describeOperation, fail, json } from '../../api-reference/describe.js';
import { noRoleOnProject, onProject } from '../routes-reference.js';

/** `configured: false` alone where the project has no Postman binding, the target where it has. */
export const postmanTargetSchema = z.union([
  z.object({ configured: z.literal(false) }),
  z.object({
    configured: z.literal(true),
    workspaceId: z.string().nullable(),
    workspaceName: z.string().nullable(),
    collectionId: z.string().nullable(),
    region: z.enum(['us', 'eu']),
    mode: z.enum(['minimal', 'full']),
  }),
]);

export const readPostmanTarget = onProject(
  describeOperation({
    summary: 'The Postman workspace and collection the project is bound to',
    responses: {
      200: json(postmanTargetSchema),
      403: noRoleOnProject,
      404: fail('NOT_FOUND', 'no such project, or the caller cannot see it'),
    },
  }),
);

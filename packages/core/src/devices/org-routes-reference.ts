import { z } from 'zod';
import { describeOperation, fail, json } from '../api-reference/declare/describe.js';
import { tableRow } from '../api-reference/declare/rows.js';
import { devices } from '../db/schema.js';
import { deviceBuildFields } from './routes-reference.js';

export const orgIdParamSchema = z.object({ orgId: z.uuid() });

/** A device bound to a project of the organisation; `capabilities` and the gate report stay with the owner. */
export const orgDeviceSchema = tableRow(devices)
  .pick({
    id: true,
    name: true,
    platform: true,
    agentVersion: true,
    agentCommit: true,
    status: true,
    disabledAt: true,
    lastSeenAt: true,
    pairedAt: true,
    gitCredentialRef: true,
    createdAt: true,
  })
  .extend({
    ...deviceBuildFields,
    runnerCount: z.number(),
    projectNames: z.array(z.string()),
    ownedByMe: z.boolean(),
  });

export const listOrgDevices = describeOperation({
  summary:
    "List the organisation's devices over the projects the caller can see, whoever paired them",
  responses: {
    200: json(z.array(orgDeviceSchema)),
    403: fail('FORBIDDEN', 'the caller is not a member of the organisation'),
    404: fail('NOT_FOUND', 'no such organisation'),
  },
});

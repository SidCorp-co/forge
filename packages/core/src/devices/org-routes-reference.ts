import { z } from 'zod';
import { describeOperation, fail, json } from '../api-reference/declare/describe.js';
import { tableRow } from '../api-reference/declare/rows.js';
import { devices } from '../db/schema.js';
import { deviceBuildFields } from './routes-reference.js';

export const orgIdParamSchema = z.object({ orgId: z.uuid() });

/** A device bound to a project of the organization, or held by one of its agents; `capabilities` and the gate report stay with the owner. */
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
    /** The organization's agent holding the device, as `@handle`; null for a person's box. */
    heldBy: z.string().nullable(),
    /** Whether the caller may revoke it: its pairer, or an admin where an agent of this organization paired it. */
    canRevoke: z.boolean(),
  });

export const listOrgDevices = describeOperation({
  summary:
    "List the organization's devices over the projects the caller can see, whoever paired them, and every live device the organization's own agents hold",
  responses: {
    200: json(z.array(orgDeviceSchema)),
    403: fail('FORBIDDEN', 'the caller is not a member of the organization'),
    404: fail('NOT_FOUND', 'no such organization'),
  },
});

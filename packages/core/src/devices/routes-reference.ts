import { z } from 'zod';
import { describeOperation, empty, fail, json } from '../api-reference/declare/describe.js';
import { tableRow } from '../api-reference/declare/rows.js';
import { devicePlatforms, devices, runnerProvisionStatuses, runners } from '../db/schema.js';
import { gateConditionSchema } from './gate-report.js';

const deviceRow = tableRow(devices);
const runnerRow = tableRow(runners);
const buildState = z.enum(['current', 'behind', 'unknown']);

/** What a box says about its own declaration gate, with the time core heard it. */
export const deviceGateSchema = gateConditionSchema.extend({ receivedAt: z.string() });

/** The build comparison every device listing adds to a row: this box against the published release. */
export const deviceBuildFields = {
  latestAgentVersion: z.string().nullable(),
  latestAgentCommit: z.string().nullable(),
  mainRunnerHead: z.string().nullable(),
  agentBuildState: buildState,
  runnerReleaseState: buildState,
  agentBuildDetail: z.string(),
  agentOutdated: z.boolean(),
};

/** One of the caller's own devices; `ownedByMe` is always true on this list. */
export const ownDeviceSchema = deviceRow
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
    capabilities: true,
    gitCredentialRef: true,
    createdAt: true,
  })
  .extend({ ...deviceBuildFields, gate: deviceGateSchema.nullable(), ownedByMe: z.literal(true) });

export const mintedCodeSchema = z.object({ code: z.string(), expiresAt: z.string() });

export const deviceStateSchema = deviceRow.pick({
  id: true,
  name: true,
  platform: true,
  status: true,
  disabledAt: true,
  lastSeenAt: true,
  pairedAt: true,
});

export const deviceRunnerAssignmentSchema = z.object({
  runnerId: z.string(),
  projectId: z.string(),
  slug: z.string(),
  name: z.string(),
  repoPath: z.string().nullable(),
  branch: z.string().nullable(),
  status: runnerRow.shape.status,
  lastSeenAt: z.date().nullable(),
  projectDefaultRepoPath: z.string().nullable(),
  baseBranch: z.string().nullable(),
  provisionStatus: runnerRow.shape.provisionStatus,
  provisionDetail: z.string().nullable(),
  provisionedAt: z.date().nullable(),
});

const gateAck = z.object({ accepted: z.boolean(), reason: z.string().optional() });

export const heartbeatAckSchema = z.object({
  ok: z.literal(true),
  serverTime: z.string(),
  gate: gateAck.optional(),
  pool: gateAck.optional(),
});

export const pluginsSchema = z.object({
  plugins: z.array(
    z.object({
      marketplace: z.string(),
      name: z.string(),
      pinnedRef: z.string().nullable().optional(),
      autoUpdate: z.boolean().optional(),
      projects: z.array(z.string()),
      pinnedRefConflict: z.array(z.string()).optional(),
    }),
  ),
});

export const runnerPathSchema = runnerRow.pick({
  id: true,
  projectId: true,
  deviceId: true,
  repoPath: true,
  branch: true,
  status: true,
});

export const runnerProvisionedSchema = runnerRow.pick({
  id: true,
  projectId: true,
  deviceId: true,
  provisionStatus: true,
});

export const pairBodySchema = z
  .object({
    code: z.string().min(8).max(64),
    name: z.string().min(1).max(80),
    platform: z.enum(devicePlatforms),
    agentVersion: z.string().max(80).optional(),
    capabilities: z.record(z.string(), z.unknown()).optional(),
    // Stable machine id (e.g. /etc/machine-id). When present, re-pairing from
    // the same machine rotates the existing device row instead of duplicating.
    machineId: z.string().min(1).max(256).optional(),
  })
  .strict();

export const heartbeatBodySchema = z
  .object({
    agentVersion: z.string().max(80).optional(),
    // The commit the running binary was built from. A box that does not send one
    // is not a published build, and is reported as such rather than as current.
    agentCommit: z.string().max(80).optional(),
    capabilities: z.record(z.string(), z.unknown()).optional(),
    // Read by `heartbeatGate`, not here: a malformed gate field must not 400 a
    // heartbeat and take the box offline with it (ISS-1192).
    gate: z.unknown().optional(),
    pool: z.unknown().optional(),
  })
  .strict();

export const mintCodeParamSchema = z.object({ id: z.uuid() });
export const deviceIdParamSchema = z.object({ id: z.uuid() });
export const runnerIdParamSchema = z.object({ runnerId: z.uuid() });

export const orgIdSchema = z.uuid();
export const ownDevicesQuerySchema = z.object({ orgId: orgIdSchema.optional() });

export const updateDeviceSchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    // Reversible "turn off" switch — true = ignore this device across every
    // project's dispatch + chat; false = re-enable. Distinct from revoke.
    disabled: z.boolean().optional(),
  })
  .strict()
  .refine((v) => v.name !== undefined || v.disabled !== undefined, {
    message: 'provide at least one of `name` or `disabled`',
  });

export const meRunnerPatchSchema = z
  .object({
    repoPath: z.string().trim().max(500).nullable().optional(),
    branch: z.string().trim().max(100).nullable().optional(),
  })
  .strict();

export const provisionStatusSchema = z
  .object({
    status: z.enum(runnerProvisionStatuses),
    detail: z.string().trim().max(2000).nullable().optional(),
  })
  .strict();

const noDevice = fail('NOT_FOUND', 'no such device');
const notOwner = fail('FORBIDDEN', 'the caller does not own the device');

export const pairResponseSchema = z.object({
  deviceId: z.string(),
  deviceToken: z.string(),
  projectId: z.string().nullable(),
});

export const pairDevice = describeOperation({
  summary: 'Exchange a pairing code for a device token',
  description: 'Public: no session needed, the code is the credential.',
  responses: {
    201: json(pairResponseSchema, 'The new device and its token, shown once'),
    400: fail({
      INVALID_CODE: 'no such pairing code',
      CODE_ALREADY_USED: 'the code was redeemed already',
      CODE_EXPIRED: 'the code is older than five minutes',
    }),
  },
});

export const listOwnDevices = describeOperation({
  summary: "List the caller's devices, optionally narrowed to one organisation's projects",
  responses: {
    200: json(z.array(ownDeviceSchema)),
    403: fail('FORBIDDEN', 'orgId names an organisation the caller is not in'),
    404: fail('NOT_FOUND', 'orgId names no organisation'),
  },
});

export const updateDevice = describeOperation({
  summary: 'Rename a device or turn it off and on',
  description: 'A revoked device cannot be turned on again; pair it afresh.',
  responses: {
    200: json(deviceStateSchema, 'The device after the change'),
    403: fail(
      'FORBIDDEN',
      'the caller does not own the device, or it is revoked and `disabled` is false',
    ),
    404: noDevice,
  },
});

export const revokeDevice = describeOperation({
  summary: 'Revoke a device: its token dies and its runner bindings are removed',
  description:
    "The account that paired the device revokes it, and so does whoever holds the admin role in an organization the agent account holding it belongs to: an agent's device is its organization's to manage.",
  responses: {
    204: empty('Revoked'),
    403: fail(
      'FORBIDDEN',
      'the caller neither paired the device nor holds the admin role in an organization whose agent paired it',
    ),
    404: noDevice,
  },
});

export const listDeviceRunners = describeOperation({
  summary: 'List the projects a device is bound to, with each runner checkout and status',
  responses: {
    200: json(z.array(deviceRunnerAssignmentSchema)),
    403: notOwner,
    404: noDevice,
  },
});

export const mintPairingCode = describeOperation({
  summary: 'Mint a five-minute pairing code for a device to redeem against this project',
  responses: {
    201: json(mintedCodeSchema, 'The code'),
    403: fail('FORBIDDEN', 'the caller is below the project member role'),
    404: fail('NOT_FOUND', 'no such project'),
    500: fail(undefined, 'five codes in a row collided with an existing one'),
  },
});

export const deviceHeartbeat = describeOperation({
  summary: 'Report that the device is alive, with its build, capabilities and gate condition',
  description:
    'A `gate` or `pool` report core cannot read is refused inside the answer (`accepted: false`), never as a 400, so the box stays online.',
  responses: {
    200: json(heartbeatAckSchema),
    401: fail('UNAUTHENTICATED', 'the device is revoked or no longer exists'),
  },
});

export const readOwnPlugins = describeOperation({
  summary: 'List the plugins the projects this device serves designate',
  responses: { 200: json(pluginsSchema), 401: fail('UNAUTHENTICATED', 'the device is revoked') },
});

export const assignmentSchema = z.object({
  projectId: z.string(),
  runnerId: z.string(),
  slug: z.string(),
  baseBranch: z.string().nullable(),
  repoPath: z.string().nullable(),
  branch: z.string().nullable(),
  status: runnerRow.shape.status,
  workspaceSetup: z.string().nullable(),
  masterPolicy: z.string().nullable(),
  rateLimitedForSeconds: z.number().nullable(),
  limitReason: runnerRow.shape.limitReason,
});

export const readOwnAssignments = describeOperation({
  summary: 'List the projects this device is bound to, with repo path, branch and rate-limit state',
  responses: {
    200: json(z.array(assignmentSchema)),
    401: fail('UNAUTHENTICATED', 'the device is revoked'),
  },
});

export const patchOwnRunner = describeOperation({
  summary: "Set the repo path and branch of one of this device's runner bindings",
  responses: {
    200: json(runnerPathSchema, 'The binding after the change'),
    401: fail('UNAUTHENTICATED', 'the device is revoked'),
    404: fail('RUNNER_NOT_FOUND', 'the runner is not this device'),
  },
});

export const reportProvisionStatus = describeOperation({
  summary: 'Report how far provisioning a project checkout has got',
  responses: {
    200: json(runnerProvisionedSchema, 'The binding with its new status'),
    401: fail('UNAUTHENTICATED', 'the device is revoked'),
    404: fail('RUNNER_NOT_FOUND', 'the runner is not this device'),
  },
});

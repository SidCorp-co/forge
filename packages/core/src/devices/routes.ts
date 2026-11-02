import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { runnerProvisionStatuses } from '../db/schema.js';
import { readBoxDesignations, unionPluginDesignations } from '../lib/plugin-designation.js';
import { type DeviceVars, requireDevice } from '../middleware/require-device.js';
import { noQuery, zValidator } from '../middleware/zod-validator.js';
import { requiresNoPermission } from '../permissions/index.js';
import {
  ANCESTRY_PAIRS_MAX,
  answerBoxAct,
  answerCheckoutAncestry,
  answerCheckoutHead,
  patchDeviceRunnerCheckout,
} from '../runners/index.js';
import { heartbeatBinaries } from './binary-report.js';
import { heartbeatDisk } from './disk-report.js';
import { heartbeatGate } from './gate-report.js';
import { heartbeatPatch } from './heartbeat-patch.js';
import { deviceProvisionRoutes } from './me-provisions.js';
import { listDeviceAssignments } from './me-runners.js';
import { pushDevice } from './push.js';
import { deviceProjectAgentConfigs } from './read.js';
import { refuseDevice } from './refusals.js';
import { recordHeartbeat, reportProvisionStatus } from './service.js';

const unauth = () =>
  new HTTPException(401, { message: 'unauthenticated', cause: { code: 'UNAUTHENTICATED' } });

const heartbeatBodySchema = z
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
    // Read by `heartbeatBinaries`, for the reason `gate` is.
    binaries: z.unknown().optional(),
    // Read by `heartbeatDisk`, for the reason `gate` is.
    disk: z.unknown().optional(),
  })
  .strict();
const DEVICE_OWN = requiresNoPermission(
  'a paired box’s device credential admits it; each read and write is selected by that device, which the service holds to the projects, sessions and requests it serves',
);

// Device-auth — agent reports in every ~30s.
export const deviceAuthRoutes = new Hono<{ Variables: DeviceVars }>();

deviceAuthRoutes.route('/', deviceProvisionRoutes);

deviceAuthRoutes.post(
  '/heartbeat',
  requireDevice(),
  DEVICE_OWN,
  zValidator('json', heartbeatBodySchema),
  async (c) => {
    const device = c.get('device');
    const input = c.req.valid('json');

    const wasOffline = device.status !== 'online';

    const gate = heartbeatGate(input.gate, device.id);
    const binaries = heartbeatBinaries(input.binaries, device.id);
    const disk = heartbeatDisk(input.disk, device);

    const beat = await recordHeartbeat(
      device.id,
      heartbeatPatch(
        { ...input, gate: gate.report, binaries: binaries.report, disk: disk.report },
        new Date(),
      ),
      input.pool,
    );
    if (!beat) throw unauth();

    if (wasOffline) {
      await pushDevice({
        deviceId: device.id,
        userId: null,
        event: 'device.status',
        data: { deviceId: device.id, status: 'online' },
      });
    }

    return c.json({
      ok: true,
      serverTime: new Date().toISOString(),
      ...gate.ack,
      ...binaries.ack,
      ...disk.ack,
      ...beat.poolAck,
    });
  },
);

// ISS-271 — assignment discovery. The runner daemon and CLI use this to learn
// which projects this device is bound to and the server-side repo path/branch,
// so the path no longer has to be hand-typed into config.toml. `requireDevice`
// already 401s on a missing/invalid/revoked token, so no extra auth handling.
deviceAuthRoutes.get('/me/runners', requireDevice(), DEVICE_OWN, noQuery, async (c) => {
  const device = c.get('device');
  return c.json(await listDeviceAssignments(device.id));
});

deviceAuthRoutes.get('/me/plugins', requireDevice(), DEVICE_OWN, noQuery, async (c) => {
  const device = c.get('device');

  const rows = await deviceProjectAgentConfigs(device.id);

  const plugins = unionPluginDesignations(readBoxDesignations(rows));

  return c.json({ plugins });
});

// ISS-271 — device self-service PATCH of its own runner repo path/branch.
// The runner CLI (`forge-runner bind`) holds a device token, not a user JWT,
// so it cannot use the owner/admin PATCH on `projectRoutes`. This endpoint lets
// a device write the SAME `runners.repoPath`/`branch` field web writes, scoped
// to runners that belong to the calling device. 404 if the runner isn't this
// device's.
const meRunnerPatchSchema = z
  .object({
    repoPath: z.string().trim().max(500).nullable().optional(),
    branch: z.string().trim().max(100).nullable().optional(),
  })
  .strict();

deviceAuthRoutes.patch(
  '/me/runners/:runnerId',
  requireDevice(),
  DEVICE_OWN,
  zValidator('param', z.object({ runnerId: z.uuid() })),
  zValidator('json', meRunnerPatchSchema),
  async (c) => {
    const device = c.get('device');
    const { runnerId } = c.req.valid('param');
    const { repoPath, branch } = c.req.valid('json');

    const runner = await patchDeviceRunnerCheckout(device.id, runnerId, { repoPath, branch });

    if (!runner) {
      throw new HTTPException(404, {
        message: 'runner not found',
        cause: { code: 'RUNNER_NOT_FOUND' },
      });
    }

    return c.json(runner);
  },
);

// Device → server provision progress report. Scoped to runners owned by the
// calling device (404 otherwise). Bridges to the project room (live stepper).
const provisionStatusSchema = z
  .object({
    status: z.enum(runnerProvisionStatuses),
    detail: z.string().trim().max(2000).nullable().optional(),
  })
  .strict();

deviceAuthRoutes.post(
  '/me/runners/:runnerId/provision-status',
  requireDevice(),
  DEVICE_OWN,
  zValidator('param', z.object({ runnerId: z.uuid() })),
  zValidator('json', provisionStatusSchema),
  async (c) => {
    const device = c.get('device');
    const { runnerId } = c.req.valid('param');
    const { status, detail } = c.req.valid('json');

    const runner = await reportProvisionStatus({
      deviceId: device.id,
      runnerId,
      status,
      detail: detail ?? null,
    });

    if (!runner) {
      throw new HTTPException(404, {
        message: 'runner not found',
        cause: { code: 'RUNNER_NOT_FOUND' },
      });
    }

    return c.json(runner);
  },
);

// Device → server: the head a box read from its bound checkout, answering `checkout.head.read`.
// Settled only for the box it was asked of; the reading is checked in `runners/checkout-head.ts`.
const checkoutHeadAnswerSchema = z
  .object({
    projectId: z.uuid(),
    sha: z.string().max(80).optional(),
    ref: z.string().max(300).optional(),
    readAt: z.string().max(40).optional(),
    via: z.string().max(40).optional(),
    origin: z.string().max(1000).optional(),
    error: z.string().trim().min(1).max(2000).optional(),
  })
  .strict();

deviceAuthRoutes.post(
  '/me/checkout-heads/:requestId',
  requireDevice(),
  DEVICE_OWN,
  zValidator('param', z.object({ requestId: z.uuid() })),
  zValidator('json', checkoutHeadAnswerSchema),
  async (c) => {
    const { requestId } = c.req.valid('param');
    const outcome = answerCheckoutHead(c.get('device').id, requestId, c.req.valid('json'));
    if (outcome.ok) return c.json({ settled: true });
    if (outcome.code === 'CHECKOUT_HEAD_NOT_ASKED') {
      throw refuseDevice(
        outcome.code,
        `no head read ${requestId} is waiting on this box: it was never asked, it was asked of another box or project, or the wait ended`,
      );
    }
    if (outcome.code === 'CHECKOUT_HEAD_OTHER_REPOSITORY') {
      throw refuseDevice(outcome.code, `the head read ${requestId} was refused: ${outcome.detail}`);
    }
    throw refuseDevice(
      outcome.code,
      `the head read ${requestId} was answered with what names no head: ${outcome.detail}`,
    );
  },
);

// Device → server: what a box did for a room's session (REQ-75 r5): a command it ran on a host
// (`host.command`), a declared read it ran (`ops.read`, ISS-871) or a working copy it committed and
// pushed (`build.push`). Settled only for the box it was asked of; what the answer says is read in
// `runners/box-acts.ts`.
const boxActAnswerSchema = z
  .object({
    projectId: z.uuid(),
    host: z.string().max(253).optional(),
    exitCode: z.number().int().nullable().optional(),
    stdout: z.string().max(70_000).optional(),
    stderr: z.string().max(70_000).optional(),
    truncated: z.boolean().optional(),
    timedOut: z.boolean().optional(),
    durationMs: z.number().int().min(0).optional(),
    branch: z.string().max(200).optional(),
    base: z.string().max(200).optional(),
    sha: z.string().max(80).optional(),
    files: z.array(z.string().max(1000)).max(2000).optional(),
    error: z.string().trim().min(1).max(4000).optional(),
  })
  .strict();

for (const path of [
  '/me/host-commands/:requestId',
  '/me/ops-reads/:requestId',
  '/me/support-builds/:requestId',
] as const) {
  deviceAuthRoutes.post(
    path,
    requireDevice(),
    requiresNoPermission(
      'a box answers what core asked of it: settled only for the device, project and request asked',
    ),
    zValidator('param', z.object({ requestId: z.uuid() })),
    zValidator('json', boxActAnswerSchema),
    async (c) => {
      const { requestId } = c.req.valid('param');
      if (answerBoxAct(c.get('device').id, requestId, c.req.valid('json'))) {
        return c.json({ settled: true });
      }
      throw refuseDevice(
        'BOX_ANSWER_NOT_ASKED',
        `nothing ${requestId} is waiting on this box: it was never asked, it was asked of another box or project, or the wait ended`,
      );
    },
  );
}

// Device → server: whether commits are ancestors, read in a box's bound checkout, answering
// `checkout.ancestry.read`. Settled only for the box it was asked of; checked in `runners/checkout-ancestry.ts`.
const checkoutAncestryAnswerSchema = z
  .object({
    projectId: z.uuid(),
    origin: z.string().max(1000).optional(),
    readAt: z.string().max(40).optional(),
    via: z.string().max(40).optional(),
    fetched: z.boolean().optional(),
    answers: z
      .array(
        z
          .object({
            commit: z.string().max(80),
            release: z.string().max(80),
            ancestor: z.boolean().optional(),
            error: z.string().trim().min(1).max(2000).optional(),
          })
          .strict(),
      )
      .max(ANCESTRY_PAIRS_MAX)
      .optional(),
    error: z.string().trim().min(1).max(2000).optional(),
  })
  .strict();

deviceAuthRoutes.post(
  '/me/checkout-ancestry/:requestId',
  requireDevice(),
  DEVICE_OWN,
  zValidator('param', z.object({ requestId: z.uuid() })),
  zValidator('json', checkoutAncestryAnswerSchema),
  async (c) => {
    const { requestId } = c.req.valid('param');
    const outcome = answerCheckoutAncestry(c.get('device').id, requestId, c.req.valid('json'));
    if (outcome.ok) return c.json({ settled: true });
    if (outcome.code === 'CHECKOUT_ANCESTRY_NOT_ASKED') {
      throw refuseDevice(
        outcome.code,
        `no ancestry read ${requestId} is waiting on this box: it was never asked, it was asked of another box or project, or the wait ended`,
      );
    }
    if (outcome.code === 'CHECKOUT_ANCESTRY_OTHER_REPOSITORY') {
      throw refuseDevice(
        outcome.code,
        `the ancestry read ${requestId} was refused: ${outcome.detail}`,
      );
    }
    throw refuseDevice(
      outcome.code,
      `the ancestry read ${requestId} was answered with what is no ancestry reading: ${outcome.detail}`,
    );
  },
);

export { installRoutes } from './install-routes.js';
export { deviceLoginRoutes } from './login-routes.js';
export { deviceMcpServerRoutes } from './mcp-servers-routes.js';
export { deviceOrgRoutes } from './org-routes.js';
export { deviceOwnerRoutes } from './owner-routes.js';
export { projectPluginConflictRoutes } from './plugin-conflict-routes.js';
export { devicePoolRoutes } from './pool-routes.js';

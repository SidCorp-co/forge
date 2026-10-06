import {
  MASTER_DIALOG_SHAPE,
  MASTER_PASS_SHAPE,
  MASTER_SESSION_SHAPE,
  type MasterPassResponse,
  type MasterSessionResponse,
  masterDialogRequestSchema,
  masterPassRequestSchema,
  masterSessionRequestSchema,
} from '@forge/contracts/master-standing';
import { Hono } from 'hono';
import { refused } from '../lib/refusal.js';
import { type DeviceVars, requireDevice } from '../middleware/require-device.js';
import { strictBody } from '../middleware/zod-validator.js';
import {
  closeMasterPass,
  declareMasterSession,
  openMasterPass,
  recordMasterDialog,
} from './service.js';

export const deviceMasterRoutes = new Hono<{ Variables: DeviceVars }>();

deviceMasterRoutes.post(
  '/me/master-session',
  requireDevice(),
  strictBody(masterSessionRequestSchema, MASTER_SESSION_SHAPE),
  async (c) => {
    const body = c.req.valid('json');
    const outcome = await declareMasterSession({
      deviceId: c.get('device').id,
      projectId: body.projectId,
      name: body.name,
      maxJobPanes: body.maxJobPanes,
    });
    if (!outcome.ok) return refused(c, outcome.refusals, 'MASTER_REFUSED');
    return c.json(outcome.session satisfies MasterSessionResponse);
  },
);

deviceMasterRoutes.post(
  '/me/master-session/pass',
  requireDevice(),
  strictBody(masterPassRequestSchema, MASTER_PASS_SHAPE),
  async (c) => {
    const body = c.req.valid('json');
    const deviceId = c.get('device').id;
    if (body.op === 'open') {
      const opened = await openMasterPass({
        deviceId,
        sessionId: body.sessionId,
        verb: body.verb,
        issueKey: body.issueKey ?? null,
        trigger: body.trigger ?? 'nudge',
      });
      if (!opened.ok) return refused(c, opened.refusals, 'MASTER_REFUSED');
      return c.json({ pass: opened.pass } satisfies MasterPassResponse, 201);
    }
    const closed = await closeMasterPass({
      deviceId,
      sessionId: body.sessionId,
      passId: body.passId,
      dispatched: body.dispatched,
      skipped: body.skipped,
      parked: body.parked,
      refused: body.refused ?? null,
    });
    if (!closed.ok) return refused(c, closed.refusals, 'MASTER_REFUSED');
    return c.json({ pass: closed.pass } satisfies MasterPassResponse);
  },
);

deviceMasterRoutes.post(
  '/me/master-session/dialog',
  requireDevice(),
  strictBody(masterDialogRequestSchema, MASTER_DIALOG_SHAPE),
  async (c) => {
    const body = c.req.valid('json');
    await recordMasterDialog({
      deviceId: c.get('device').id,
      sessionId: body.sessionId,
      dialog: body.dialog,
    });
    return c.json({ sessionId: body.sessionId, dialog: body.dialog });
  },
);

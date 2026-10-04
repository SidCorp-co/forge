import {
  MASTER_PASS_SHAPE,
  MASTER_SESSION_SHAPE,
  type MasterPassResponse,
  type MasterSessionResponse,
  masterPassRequestSchema,
  masterSessionRequestSchema,
} from '@forge/contracts/master-standing';
import { Hono } from 'hono';
import { type DeviceVars, requireDevice } from '../middleware/require-device.js';
import { strictBody } from '../middleware/zod-validator.js';
import { refused } from '../project-config/respond.js';
import { closeMasterPass, declareMasterSession, openMasterPass } from './service.js';

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
    if (!outcome.ok) return refused(c, outcome.refusals);
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
      });
      if (!opened.ok) return refused(c, opened.refusals);
      return c.json({ pass: opened.pass } satisfies MasterPassResponse, 201);
    }
    const closed = await closeMasterPass({
      deviceId,
      sessionId: body.sessionId,
      dispatched: body.dispatched,
      skipped: body.skipped,
      parked: body.parked,
    });
    if (!closed.ok) return refused(c, closed.refusals);
    return c.json({ pass: closed.pass } satisfies MasterPassResponse);
  },
);

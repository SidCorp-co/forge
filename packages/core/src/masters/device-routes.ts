import {
  MASTER_DIALOG_SHAPE,
  MASTER_PANE_SHAPE,
  MASTER_PASS_SHAPE,
  MASTER_SESSION_SHAPE,
  type MasterPaneResponse,
  type MasterPassResponse,
  type MasterPassSettleResponse,
  type MasterSessionResponse,
  masterDialogRequestSchema,
  masterPaneRequestSchema,
  masterPassRequestSchema,
  masterSessionRequestSchema,
} from '@forge/contracts/master-standing';
import {
  MASTER_VERDICT_SHAPE,
  type MasterVerdictAnswer,
  masterVerdictRequestSchema,
} from '@forge/contracts/master-verdict';
import { Hono } from 'hono';
import { refused } from '../lib/refusal.js';
import { type DeviceVars, requireDevice } from '../middleware/require-device.js';
import { strictBody } from '../middleware/zod-validator.js';
import { requiresNoPermission } from '../permissions/index.js';
import {
  declareMasterSession,
  judgeMaster,
  openMasterPass,
  recordMasterDialog,
  recordMasterPane,
  settleMasterPass,
} from './service.js';

export const deviceMasterRoutes = new Hono<{ Variables: DeviceVars }>();

// the paired box is the whole credential; the service refuses a project, session or pass the box
// does not hold, a data rule each read selects by the device
const BOX_OWN = requiresNoPermission(
  'a paired box acts for its own master session, on a project it serves; the service refuses one it does not hold',
);

deviceMasterRoutes.post(
  '/me/master-session',
  requireDevice(),
  BOX_OWN,
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
  BOX_OWN,
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
    const settled = await settleMasterPass({
      deviceId,
      sessionId: body.sessionId,
      passId: body.passId,
      facts: body.facts,
    });
    if (!settled.ok) return refused(c, settled.refusals, 'MASTER_REFUSED');
    return c.json(settled.settled satisfies MasterPassSettleResponse);
  },
);

deviceMasterRoutes.post(
  '/me/master-session/dialog',
  requireDevice(),
  BOX_OWN,
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

// the master's beat carries what its pane's hooks say between passes (ISS-951); a box that predates
// it sends none, and its standing reads the pane as of its last pass
deviceMasterRoutes.post(
  '/me/master-session/pane',
  requireDevice(),
  BOX_OWN,
  strictBody(masterPaneRequestSchema, MASTER_PANE_SHAPE),
  async (c) => {
    const body = c.req.valid('json');
    const { changed } = await recordMasterPane({
      deviceId: c.get('device').id,
      sessionId: body.sessionId,
      pane: body.pane,
    });
    return c.json({ sessionId: body.sessionId, changed } satisfies MasterPaneResponse);
  },
);

deviceMasterRoutes.post(
  '/me/master-session/verdict',
  requireDevice(),
  BOX_OWN,
  strictBody(masterVerdictRequestSchema, MASTER_VERDICT_SHAPE),
  async (c) => {
    const body = c.req.valid('json');
    const answer = await judgeMaster({
      deviceId: c.get('device').id,
      projectId: body.projectId,
      runnerId: body.runnerId,
      facts: body.facts,
    });
    return c.json(answer satisfies MasterVerdictAnswer);
  },
);

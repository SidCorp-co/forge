// The Forge Box REST surface (`@forge/contracts/boxes:BOX_ROUTES`, ISS-1276): an agent opens, drives,
// marks spans on and closes a box; a person opens one to test by hand, takes it, hands it back and
// mints a ticket to watch it; the device reports with its credential. Each route validates, calls
// one service function and answers.

import { boxReportSchema } from '@forge/contracts/box-wire';
import {
  BOX_SESSION_CLIP,
  boxActRequestSchema,
  boxAttachRequestSchema,
  boxCloseRequestSchema,
  boxRecordingRequestSchema,
  boxSpanRequestSchema,
  boxTicketRequestSchema,
  openBoxRequestSchema,
} from '@forge/contracts/boxes';
import { Hono } from 'hono';
import { z } from 'zod';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { type DeviceVars, requireDevice } from '../middleware/require-device.js';
import { invalid, noQuery, rawBody, zValidator } from '../middleware/zod-validator.js';
import { requiresNoPermission, requiresOnResolved } from '../permissions/index.js';
import type { BoxActor } from './access.js';
import { agentAct } from './acts.js';
import { attachBox } from './attach.js';
import { boxActsAfter, boxSpansOf, projectBoxes } from './read.js';
import { setBoxRecording } from './recording.js';
import { reportBox } from './report.js';
import { closeBox, openBox, readBox, releaseBox, takeBox } from './service.js';
import { attachSession } from './session.js';
import { attachSpanClip, markSpan } from './spans.js';
import { mintBoxTicket } from './viewer.js';

const projectParam = z.strictObject({ id: z.uuid() });
const boxParam = z.strictObject({ id: z.uuid() });
const clipParam = z.strictObject({
  id: z.uuid(),
  spanId: z.union([z.uuid(), z.literal(BOX_SESSION_CLIP)]),
});
const PATH = invalid('invalid path: /api/boxes/<box id>');
const ON_BOX = 'the project of the box the path names';

const actorOf = (c: { get(key: 'userId'): string; get(key: 'agency'): AuthVars['agency'] }) => {
  const agency = c.get('agency');
  if (!agency) throw new Error('boxes: a request reached its handler without an auth gate');
  return { userId: c.get('userId'), agency } satisfies BoxActor;
};

/** A project's boxes, under `/api/projects`: GET the list and its queue, POST to open one. */
export const projectBoxRoutes = new Hono<{ Variables: AuthVars }>();
projectBoxRoutes.use('/:id/boxes', requireAuth(), assertEmailVerified());

projectBoxRoutes.get(
  '/:id/boxes',
  zValidator('param', projectParam, invalid('invalid path: /api/projects/<project id>/boxes')),
  requiresOnResolved('project.read', 'the project the path names'),
  noQuery,
  async (c) => c.json({ boxes: await projectBoxes(c.req.valid('param').id) }),
);

projectBoxRoutes.post(
  '/:id/boxes',
  zValidator('param', projectParam, invalid('invalid path: /api/projects/<project id>/boxes')),
  requiresOnResolved('project.write', 'the project the path names'),
  zValidator(
    'json',
    openBoxRequestSchema,
    invalid(
      'invalid body: { mode: browser | android | desktop, issueId?, criterion?, runId?, deviceId?, viewport?: { width, height }, url?, asPerson?, record? }',
    ),
  ),
  async (c) =>
    c.json({ box: await openBox(actorOf(c), c.req.valid('param').id, c.req.valid('json')) }, 201),
);

/** One box, under `/api/boxes`. */
export const boxRoutes = new Hono<{ Variables: AuthVars & DeviceVars }>();

// The device's report and its clip upload come first, under their own gate.
const DEVICE_OWN = requiresNoPermission(
  "the device's credential; a box its device does not hold is not found (BOX_NOT_FOUND)",
);

boxRoutes.post(
  '/:id/report',
  requireDevice(),
  DEVICE_OWN,
  zValidator('param', boxParam, PATH),
  zValidator(
    'json',
    boxReportSchema,
    invalid(
      'invalid body: { kind: state | offer | act | mark | clip_failed | session_failed | cdp | recording, … } (`@forge/contracts/box-wire`)',
    ),
  ),
  async (c) =>
    c.json({
      box: await reportBox(c.get('device').id, c.req.valid('param').id, c.req.valid('json')),
    }),
);

boxRoutes.post(
  '/:id/spans/:spanId/clip',
  requireDevice(),
  DEVICE_OWN,
  zValidator(
    'param',
    clipParam,
    invalid('invalid path: /api/boxes/<box id>/spans/<span id | session>/clip'),
  ),
  rawBody(
    'multipart/form-data',
    "The span's cut: `clip` (video/webm or video/mp4, within the release page ceiling) and `still` (image/png). With `session` for the span, the box's whole kept recording within `BOX_LIMITS.sessionMaxBytes` (ISS-1338).",
  ),
  async (c) => {
    const body = await c.req.parseBody();
    const clip = body.clip;
    const still = body.still;
    if (!(clip instanceof File) || !(still instanceof File)) {
      return c.json(
        {
          error: {
            code: 'BAD_REQUEST',
            message: 'multipart fields `clip` (webm or mp4) and `still` (png) are both required',
          },
        },
        400,
      );
    }
    const { id, spanId } = c.req.valid('param');
    const cut = { bytes: Buffer.from(await clip.arrayBuffer()), mime: clip.type };
    const opening = {
      bytes: Buffer.from(await still.arrayBuffer()),
      mime: still.type || 'image/png',
    };
    if (spanId === BOX_SESSION_CLIP) {
      return c.json({ box: await attachSession(c.get('device').id, id, cut, opening) });
    }
    return c.json({ span: await attachSpanClip(c.get('device').id, id, spanId, cut, opening) });
  },
);

for (const at of [
  '/:id',
  '/:id/close',
  '/:id/take',
  '/:id/release',
  '/:id/recording',
  '/:id/acts',
  '/:id/attach',
  '/:id/spans',
  '/:id/ticket',
]) {
  boxRoutes.use(at, requireAuth(), assertEmailVerified());
}

boxRoutes.get(
  '/:id',
  zValidator('param', boxParam, PATH),
  requiresOnResolved('project.read', ON_BOX),
  noQuery,
  async (c) => c.json({ box: await readBox(c.req.valid('param').id, actorOf(c)) }),
);

boxRoutes.post(
  '/:id/close',
  zValidator('param', boxParam, PATH),
  requiresOnResolved('project.write', ON_BOX),
  zValidator('json', boxCloseRequestSchema, invalid('invalid body: { reason? }')),
  async (c) =>
    c.json({
      box: await closeBox(c.req.valid('param').id, actorOf(c), c.req.valid('json').reason),
    }),
);

boxRoutes.post(
  '/:id/take',
  zValidator('param', boxParam, PATH),
  requiresOnResolved('project.write', ON_BOX),
  async (c) => c.json({ box: await takeBox(c.req.valid('param').id, actorOf(c)) }),
);

boxRoutes.post(
  '/:id/release',
  zValidator('param', boxParam, PATH),
  requiresOnResolved('project.write', ON_BOX),
  async (c) => c.json({ box: await releaseBox(c.req.valid('param').id, actorOf(c)) }),
);

boxRoutes.post(
  '/:id/acts',
  zValidator('param', boxParam, PATH),
  requiresOnResolved('project.write', ON_BOX),
  zValidator(
    'json',
    boxActRequestSchema,
    invalid('invalid body: { command: [verb, ...args], runId? }'),
  ),
  async (c) => {
    const { command, runId } = c.req.valid('json');
    return c.json(await agentAct(actorOf(c), c.req.valid('param').id, command, runId));
  },
);

// an agent on the box's own device takes the mode's native endpoint (ISS-1322); the credential's
// device is where it calls from, and one bound to none is no agent on that device
boxRoutes.post(
  '/:id/attach',
  zValidator('param', boxParam, PATH),
  requiresOnResolved('project.write', ON_BOX),
  zValidator('json', boxAttachRequestSchema, invalid('invalid body: { runId? }')),
  async (c) => {
    c.header('Cache-Control', 'no-store');
    const { runId } = c.req.valid('json');
    return c.json(
      await attachBox(actorOf(c), c.get('patDeviceId') ?? null, c.req.valid('param').id, runId),
    );
  },
);

boxRoutes.post(
  '/:id/recording',
  zValidator('param', boxParam, PATH),
  requiresOnResolved('project.write', ON_BOX),
  zValidator('json', boxRecordingRequestSchema, invalid('invalid body: { on: true | false }')),
  async (c) =>
    c.json({
      box: await setBoxRecording(c.req.valid('param').id, actorOf(c), c.req.valid('json').on),
    }),
);

const feedQuery = z.strictObject({
  after: z.coerce.number().int().min(0).optional(),
  by: z.enum(['agent', 'person']).optional(),
});

boxRoutes.get(
  '/:id/acts',
  zValidator('param', boxParam, PATH),
  requiresOnResolved('project.read', ON_BOX),
  zValidator('query', feedQuery, invalid('invalid query: ?after=<seq>&by=agent|person')),
  async (c) => {
    const { id } = c.req.valid('param');
    await readBox(id, actorOf(c));
    const { after, by } = c.req.valid('query');
    return c.json({ acts: await boxActsAfter(id, after ?? 0, by) });
  },
);

boxRoutes.post(
  '/:id/spans',
  zValidator('param', boxParam, PATH),
  requiresOnResolved('project.write', ON_BOX),
  zValidator(
    'json',
    boxSpanRequestSchema,
    invalid('invalid body: { criterion: n, edge: start | end }'),
  ),
  async (c) => {
    const { criterion, edge } = c.req.valid('json');
    return c.json(
      { span: await markSpan(actorOf(c), c.req.valid('param').id, criterion, edge) },
      201,
    );
  },
);

boxRoutes.get(
  '/:id/spans',
  zValidator('param', boxParam, PATH),
  requiresOnResolved('project.read', ON_BOX),
  noQuery,
  async (c) => {
    const { id } = c.req.valid('param');
    await readBox(id, actorOf(c));
    return c.json({ spans: await boxSpansOf(id) });
  },
);

boxRoutes.post(
  '/:id/ticket',
  zValidator('param', boxParam, PATH),
  requiresOnResolved('project.read', ON_BOX),
  zValidator('json', boxTicketRequestSchema, invalid('invalid body: { channel: view | input }')),
  async (c) => {
    c.header('Cache-Control', 'no-store');
    return c.json(
      await mintBoxTicket(c.req.valid('param').id, actorOf(c), c.req.valid('json').channel),
    );
  },
);

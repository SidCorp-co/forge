// The preview REST surface (`@forge/contracts/preview:PREVIEW_ROUTES`): a person opens, reads,
// views, approves, abandons and messages a preview with a Forge session; the box reports on it with
// its device credential. Each route validates, calls one service function and answers.

import {
  confirmFixRequestSchema,
  issuePreviewResponseSchema,
  openPreviewRequestSchema,
  PREVIEW_LIMITS,
  previewApproveResponseSchema,
  previewEnvelopeSchema,
  previewMessageRequestSchema,
  previewMessageResponseSchema,
  previewReportSchema,
  previewTicketResponseSchema,
} from '@forge/contracts/preview';
import {
  confirmFixResponseSchema,
  recordingEnvelopeSchema,
  recordingEventsResponseSchema,
  recordingsResponseSchema,
} from '@forge/contracts/reproduce';
import { Hono } from 'hono';
import { z } from 'zod';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { type DeviceVars, requireDevice } from '../middleware/require-device.js';
import { invalid, zValidator } from '../middleware/zod-validator.js';
import { confirmFix } from './confirm.js';
import {
  readRecording,
  recordingEvents,
  recordingsOfFeedback,
  stopRecording,
} from './recordings.js';
import {
  abandonPreview,
  approvePreview,
  mintPreviewTicket,
  openIssuePreview,
  type PreviewActor,
  readIssuePreview,
  readPreview,
  reportPreview,
  sendPreviewMessage,
} from './service.js';
import { openSubjectPreview } from './subjects.js';

const issueParam = z.strictObject({ issueId: z.uuid() });
const previewParam = z.strictObject({ id: z.uuid() });
const abandonBody = z.strictObject({
  reason: z.string().trim().max(PREVIEW_LIMITS.detail).optional(),
});

const actorOf = (c: { get(key: 'userId'): string; get(key: 'agency'): AuthVars['agency'] }) => {
  const agency = c.get('agency');
  if (!agency) throw new Error('previews: a request reached its handler without an auth gate');
  return { userId: c.get('userId'), agency } satisfies PreviewActor;
};

/** An issue's preview, under `/api/issues`: GET the latest, POST to open (or reopen) it. */
export const issuePreviewRoutes = new Hono<{ Variables: AuthVars }>();
issuePreviewRoutes.use('/:issueId/preview', requireAuth(), assertEmailVerified());

issuePreviewRoutes.get(
  '/:issueId/preview',
  zValidator('param', issueParam, invalid('invalid path: /api/issues/<issue id>/preview')),
  async (c) =>
    c.json(
      issuePreviewResponseSchema.parse({
        preview: await readIssuePreview(c.req.valid('param').issueId, actorOf(c)),
      }),
    ),
);

issuePreviewRoutes.post(
  '/:issueId/preview',
  zValidator('param', issueParam, invalid('invalid path: /api/issues/<issue id>/preview')),
  async (c) => {
    const opened = await openIssuePreview(c.req.valid('param').issueId, actorOf(c));
    return c.json(
      previewEnvelopeSchema.parse({ preview: opened.preview }),
      opened.reopened ? 200 : 201,
    );
  },
);

/** One preview, under `/api/previews`. */
export const previewRoutes = new Hono<{ Variables: AuthVars & DeviceVars }>();

const PATH = invalid('invalid path: /api/previews/<preview id>');

// The box's report comes first, under its own gate: a person's session never reaches it.
previewRoutes.post(
  '/:id/report',
  requireDevice(),
  zValidator('param', previewParam, PATH),
  zValidator(
    'json',
    previewReportSchema,
    invalid(
      'invalid body: { kind: facts, facts } | { kind: live, port } | { kind: failed, reason, detail } | { kind: snapshot, base, patchId, files }',
    ),
  ),
  async (c) =>
    c.json(
      previewEnvelopeSchema.parse({
        preview: await reportPreview(
          c.get('device').id,
          c.req.valid('param').id,
          c.req.valid('json'),
        ),
      }),
    ),
);

for (const at of [
  '/:id',
  '/:id/ticket',
  '/:id/approve',
  '/:id/abandon',
  '/:id/messages',
  '/:id/confirm',
]) {
  previewRoutes.use(at, requireAuth(), assertEmailVerified());
}

previewRoutes.get('/:id', zValidator('param', previewParam, PATH), async (c) =>
  c.json(
    previewEnvelopeSchema.parse({
      preview: await readPreview(c.req.valid('param').id, actorOf(c)),
    }),
  ),
);

previewRoutes.post('/:id/ticket', zValidator('param', previewParam, PATH), async (c) => {
  c.header('Cache-Control', 'no-store');
  return c.json(
    previewTicketResponseSchema.parse(await mintPreviewTicket(c.req.valid('param').id, actorOf(c))),
  );
});

previewRoutes.post('/:id/approve', zValidator('param', previewParam, PATH), async (c) =>
  c.json(
    previewApproveResponseSchema.parse(await approvePreview(c.req.valid('param').id, actorOf(c))),
  ),
);

previewRoutes.post(
  '/:id/abandon',
  zValidator('param', previewParam, PATH),
  zValidator('json', abandonBody, invalid('invalid body: { reason?: string }')),
  async (c) => {
    const { reason } = c.req.valid('json');
    return c.json(
      previewEnvelopeSchema.parse({
        preview: await abandonPreview(c.req.valid('param').id, actorOf(c), reason),
      }),
    );
  },
);

previewRoutes.post(
  '/:id/messages',
  zValidator('param', previewParam, PATH),
  zValidator(
    'json',
    previewMessageRequestSchema,
    invalid(`invalid body: { text: 1..${PREVIEW_LIMITS.message} characters }`),
  ),
  async (c) =>
    c.json(
      previewMessageResponseSchema.parse(
        await sendPreviewMessage(c.req.valid('param').id, actorOf(c), c.req.valid('json').text),
      ),
      202,
    ),
);

// The reporter's word on a fix preview (REQ-41 BC-20). The body's shape is checked here; "not fixed"
// without a note is refused by name in the service, PREVIEW_CONFIRM_REASON_REQUIRED.
previewRoutes.post(
  '/:id/confirm',
  zValidator('param', previewParam, PATH),
  zValidator(
    'json',
    z.strictObject(confirmFixRequestSchema.shape),
    invalid('invalid body: { verdict: fixed | not_fixed, note?: what is still wrong }'),
  ),
  async (c) =>
    c.json(
      confirmFixResponseSchema.parse({
        confirmations: await confirmFix(c.req.valid('param').id, actorOf(c), c.req.valid('json')),
      }),
      201,
    ),
);

const projectParam = z.strictObject({ id: z.uuid() });

/**
 * Previews no issue's run holds, under `/api/projects` (REQ-41): open an idea or a reproduce, and
 * a feedback item's recordings, which open only for the project's signed-in members (BC-21).
 */
export const projectPreviewRoutes = new Hono<{ Variables: AuthVars }>();
projectPreviewRoutes.use('/:id/previews', requireAuth(), assertEmailVerified());
projectPreviewRoutes.use('/:id/feedback/:fb/recordings', requireAuth(), assertEmailVerified());

projectPreviewRoutes.post(
  '/:id/previews',
  zValidator('param', projectParam, invalid('invalid path: /api/projects/<project id>/previews')),
  zValidator(
    'json',
    openPreviewRequestSchema,
    invalid(
      'invalid body: { kind: idea, about: REQ-n | FB-n, brief } | { kind: reproduce, feedback: FB-n, build?: { release } | { sha }, record? }',
    ),
  ),
  async (c) =>
    c.json(
      previewEnvelopeSchema.parse({
        preview: await openSubjectPreview(c.req.valid('param').id, c.req.valid('json'), actorOf(c)),
      }),
      201,
    ),
);

projectPreviewRoutes.get(
  '/:id/feedback/:fb/recordings',
  zValidator(
    'param',
    z.strictObject({ id: z.uuid(), fb: z.string().regex(/^FB-\d{1,9}$/) }),
    invalid('invalid path: /api/projects/<project id>/feedback/FB-<n>/recordings'),
  ),
  async (c) => {
    const { id, fb } = c.req.valid('param');
    return c.json(
      recordingsResponseSchema.parse({
        recordings: await recordingsOfFeedback(id, fb, actorOf(c)),
      }),
    );
  },
);

/** One recording, under `/api/recordings`: members only (BC-21). */
export const recordingRoutes = new Hono<{ Variables: AuthVars }>();
const RECORDING_PATH = invalid('invalid path: /api/recordings/<recording id>');
for (const at of ['/:id', '/:id/events', '/:id/stop']) {
  recordingRoutes.use(at, requireAuth(), assertEmailVerified());
}

recordingRoutes.get('/:id', zValidator('param', previewParam, RECORDING_PATH), async (c) =>
  c.json(
    recordingEnvelopeSchema.parse({
      recording: await readRecording(c.req.valid('param').id, actorOf(c)),
    }),
  ),
);

recordingRoutes.get('/:id/events', zValidator('param', previewParam, RECORDING_PATH), async (c) =>
  c.json(
    recordingEventsResponseSchema.parse({
      events: await recordingEvents(c.req.valid('param').id, actorOf(c)),
    }),
  ),
);

recordingRoutes.post('/:id/stop', zValidator('param', previewParam, RECORDING_PATH), async (c) =>
  c.json(
    recordingEnvelopeSchema.parse({
      recording: await stopRecording(c.req.valid('param').id, actorOf(c)),
    }),
  ),
);

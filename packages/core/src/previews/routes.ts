// The preview REST surface (`@forge/contracts/preview:PREVIEW_ROUTES`): a person opens, reads,
// views, approves, abandons and messages a preview with a Forge session; the box reports on it with
// its device credential. Each route validates, calls one service function and answers.

import {
  issuePreviewResponseSchema,
  PREVIEW_LIMITS,
  previewApproveResponseSchema,
  previewEnvelopeSchema,
  previewMessageRequestSchema,
  previewMessageResponseSchema,
  previewReportSchema,
  previewTicketResponseSchema,
} from '@forge/contracts/preview';
import { Hono } from 'hono';
import { z } from 'zod';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { type DeviceVars, requireDevice } from '../middleware/require-device.js';
import { invalid, zValidator } from '../middleware/zod-validator.js';
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

for (const at of ['/:id', '/:id/ticket', '/:id/approve', '/:id/abandon', '/:id/messages']) {
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

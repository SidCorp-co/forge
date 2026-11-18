// `DELETE /api/projects/:id/feedback/:fb/attachments/:aid` (ISS-1327): one attachment and its bytes
// deleted, the item's other attachments and text kept, and why written on its record. Who may is the
// service's to check (`attachment-delete.ts`): the item's writer, or a holder of feedback.redact.

import {
  FEEDBACK_ATTACHMENT_DELETE_SHAPE,
  type FeedbackResponse,
  feedbackAttachmentDeleteRequestSchema,
} from '@forge/contracts/feedback';
import type { Hono } from 'hono';
import { z } from 'zod';
import { refused } from '../lib/refusal.js';
import type { AuthVars } from '../middleware/auth.js';
import { invalid, strictBody, zValidator } from '../middleware/zod-validator.js';
import { requiresOnParam } from '../permissions/index.js';
import { deleteAttachment } from './attachment-delete.js';

export function mountAttachmentDelete(app: Hono<{ Variables: AuthVars }>): void {
  app.delete(
    '/:id/feedback/:fb/attachments/:aid',
    zValidator(
      'param',
      z.object({ id: z.uuid(), fb: z.string().trim().min(1).max(64), aid: z.uuid() }),
      invalid('invalid path: a project uuid, a feedback key and an attachment uuid'),
    ),
    requiresOnParam('project.read', 'id'),
    strictBody(feedbackAttachmentDeleteRequestSchema, FEEDBACK_ATTACHMENT_DELETE_SHAPE),
    async (c) => {
      const { id, fb, aid } = c.req.valid('param');
      const agency = c.get('agency');
      if (!agency) throw new Error('feedback: a request reached its handler without an auth gate');
      const out = await deleteAttachment({
        projectId: id,
        ref: fb,
        attachmentId: aid,
        reason: c.req.valid('json').reason,
        actor: { userId: c.get('userId'), agency },
      });
      if (!out.ok) return refused(c, out.refusals, 'FEEDBACK_REFUSED');
      const body: FeedbackResponse = { feedback: out.feedback };
      return c.json(body);
    },
  );
}

import { z } from 'zod';
import { modelTierSchema } from './session-model.js';

export const sendBodySchema = z
  .object({
    sessionId: z.uuid(),
    /**
     * ISS-499 — empty is allowed when attachmentIds are present (a files-only
     * send, e.g. a screenshot with no caption); the refine below is what
     * enforces that a turn carries either text or at least one attachment.
     */
    message: z.string().max(40_000),
    claudeSessionId: z.string().max(500).nullable().optional(),
    deviceId: z.uuid().nullable().optional(),
    attachmentIds: z.array(z.uuid()).max(10).optional(),
    model: modelTierSchema.nullable().optional(),
    /**
     * ISS-1268 — for a session whose turn is running: `now` steers that turn, `next` answers this
     * message after it. A session with no turn running takes the message as a turn of its own.
     */
    priority: z.enum(['now', 'next']).optional(),
  })
  .strict()
  .refine((d) => d.message.trim().length > 0 || (d.attachmentIds?.length ?? 0) > 0, {
    message: 'message or attachmentIds required',
    path: ['message'],
  });

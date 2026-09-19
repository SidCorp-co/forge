import { z } from 'zod';
import { agentSessionStatuses } from '../db/schema.js';
import { SKILL_NAME_RE } from '../skills/skill-name.js';
import { pageContextSchema } from './page-context.js';
import { modelTierSchema } from './session-model.js';

export const startBodySchema = z
  .object({
    projectSlug: z.string().min(1).max(120),
    prompt: z.string().min(1).max(40_000).optional(),
    repoPath: z.string().max(2000).nullable().optional(),
    preBuilt: z.boolean().optional(),
    issueIds: z.array(z.uuid()).max(50).optional(),
    type: z.string().max(80).optional(),
    origin: z.string().max(40).optional(),
    pageContext: pageContextSchema.optional(),
    /** ISS-499 — session attachments to attach to the first turn. */
    attachmentIds: z.array(z.uuid()).max(10).optional(),
    skillName: z.string().regex(SKILL_NAME_RE).optional(),
    /**
     * ISS-718 — the model this session should run on, remembered on the session
     * and re-sent on every later turn. Absent = Claude Code's configured Default.
     */
    model: modelTierSchema.nullable().optional(),
  })
  .strict();

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
    origin: z.string().max(40).optional(),
    pageContext: pageContextSchema.optional(),
    attachmentIds: z.array(z.uuid()).max(10).optional(),
    model: modelTierSchema.nullable().optional(),
  })
  .strict()
  .refine((d) => d.message.trim().length > 0 || (d.attachmentIds?.length ?? 0) > 0, {
    message: 'message or attachmentIds required',
    path: ['message'],
  });

export const abortBodySchema = z
  .object({
    sessionId: z.uuid(),
  })
  .strict();

export const setRunnerBodySchema = z.object({ deviceId: z.uuid().nullable() }).strict();

export const buildPromptBodySchema = z
  .object({
    projectSlug: z.string().min(1).max(120),
    issueIds: z.array(z.uuid()).min(1).max(50),
  })
  .strict();

export const promptBuiltBodySchema = z
  .object({
    requestId: z.string().min(1).max(120),
    prompt: z.string().max(80_000).optional(),
    error: z.string().max(2000).optional(),
  })
  .strict()
  .refine((o) => o.prompt !== undefined || o.error !== undefined, {
    message: 'prompt or error required',
  });

export const desktopStatusSchema = z
  .object({
    sessionId: z.uuid(),
    status: z.enum(agentSessionStatuses),
    note: z.string().max(2000).nullable().optional(),
  })
  .strict();

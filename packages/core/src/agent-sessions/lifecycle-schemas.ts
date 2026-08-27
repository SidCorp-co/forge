// Request bodies for the static-path lifecycle routes (start / send / abort /
// runner / build-prompt / prompt-built / desktop status). Split out of
// `lifecycle-routes.ts` so that file stays inside its frozen length budget
// (.forge/size-baseline.json) — the handlers are what belong there, the wire
// shapes are a contract of their own and are what an API consumer reads.

import { z } from 'zod';
import { agentSessionStatuses } from '../db/schema.js';
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
    /**
     * ISS-733 — run an install_only project skill as turn 1 (chat-runs-skill).
     * The route validates this against the project's registered effective
     * skills, so an arbitrary caller cannot slash-inject a skill it has not
     * been granted.
     */
    skillName: z.string().min(1).max(128).optional(),
    /**
     * ISS-718 — the model this session should run on, remembered on the session
     * and re-sent on every later turn. Absent = the runner's default.
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
    /**
     * An explicit runner pick from the chat runner picker: dispatch THIS turn
     * (and re-pin the session) to this device instead of reusing the pin or
     * auto-picking. Validated in `resolveChatDevice` against the chat-capable
     * gate.
     */
    deviceId: z.uuid().nullable().optional(),
    origin: z.string().max(40).optional(),
    pageContext: pageContextSchema.optional(),
    /** ISS-499 — session attachments to attach to this turn. */
    attachmentIds: z.array(z.uuid()).max(10).optional(),
    /**
     * ISS-718 — switch the session's model from this turn on. Three states, and
     * the difference matters: OMITTED keeps whatever the session last picked
     * (`metadata.model`), an explicit tier switches to it, and an explicit
     * `null` clears the pick so the turn runs on the runner's default again.
     */
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

// cm:why deviceId: null means Auto — clears the pin so the next turn auto-picks
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

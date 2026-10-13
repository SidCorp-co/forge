import { z } from 'zod';
import { describeOperation, fail, json } from '../api-reference/declare/describe.js';
import { okSchema, sessionSchema } from './routes-reference.js';

/** Exactly one of the two must be given; a caller with neither is told so. */
export const desktopStatusQuerySchema = z
  .object({
    deviceId: z.uuid().optional(),
    projectSlug: z.string().min(1).max(120).optional(),
  })
  .refine((o) => o.deviceId || o.projectSlug, {
    message: 'deviceId or projectSlug is required',
  });

export const buildPromptRequestedSchema = z.object({ requestId: z.string() });
export const desktopConnectedSchema = z.object({ data: z.object({ connected: z.boolean() }) });

const noSession = fail('NOT_FOUND', 'no such agent session, or its project');
const noProject = fail('NOT_FOUND', 'no such project');
const noClient = fail('NO_CLAUDE_CLIENT', 'no online chat-capable runner can take the turn');
const notYours = fail('FORBIDDEN', 'the caller is not the session owner or a project admin');

export const startSession = describeOperation({
  summary: 'Open a chat session and send its first prompt in one call',
  description:
    'A `skillName` must be an install-only skill of the project. The title comes from the linked issues or the first words of the prompt.',
  responses: {
    201: json(sessionSchema, 'The session, queued on a runner'),
    400: fail(
      'BAD_REQUEST',
      '`type` was sent, `prompt` is missing, or `skillName` is not install-only for the project',
    ),
    403: fail('FORBIDDEN', 'the caller is below the project member role'),
    404: noProject,
    409: noClient,
  },
});

export const sendToSession = describeOperation({
  summary: 'Send a user turn on a session, on the runner it names or the one it is pinned to',
  responses: {
    200: json(okSchema),
    403: notYours,
    404: fail('NOT_FOUND', 'no such agent session or project'),
    409: noClient,
  },
});

export const abortSession = describeOperation({
  summary: 'Stop the in-flight turn and leave the session idle so it can be resumed',
  responses: { 200: json(okSchema), 403: notYours, 404: noSession },
});

export const cancelSession = describeOperation({
  summary: 'Cancel a session for good, failing it as user-cancelled',
  description:
    'Unlike `abort`, which leaves the session idle to resume, this is terminal and the loop monitor then routes any linked job through recovery or escalation. A session already completed or failed is returned as it is.',
  responses: {
    200: json(sessionSchema, 'The session after the cancel'),
    403: notYours,
    404: noSession,
  },
});

export const setSessionRunner = describeOperation({
  summary: 'Pin a session to another runner, or back to Auto with `deviceId: null`',
  responses: {
    200: json(sessionSchema, 'The session with its new pin'),
    403: notYours,
    404: fail('NOT_FOUND', 'no such agent session or project'),
    409: fail({
      SESSION_BUSY: 'the agent is still working on the conversation',
      NO_REPO_PATH: 'the runner has no project folder configured',
      NO_CLAUDE_CLIENT: 'the picked runner is offline or not chat-capable for the project',
    }),
  },
});

export const requestPromptBuild = describeOperation({
  summary: 'Ask an online device to assemble the prompt for some issues',
  description: 'The prompt arrives later on the `agent:prompt-built` room, keyed by `requestId`.',
  responses: {
    200: json(buildPromptRequestedSchema),
    403: fail('FORBIDDEN', 'the caller is below the project member role'),
    404: noProject,
    503: fail('NO_DEVICE', 'no device of the project is online'),
  },
});

export const relayPromptBuilt = describeOperation({
  summary: "Hand a device's assembled prompt, or its error, to whoever waits on the request id",
  responses: { 200: json(okSchema) },
});

export const setDesktopSessionStatus = describeOperation({
  summary: 'Set the status of a session the desktop client runs',
  description:
    'A completed schedule session also writes back its skill-improve or steward report; a failed one is classified.',
  responses: {
    200: json(sessionSchema, 'The session after the change'),
    403: fail('FORBIDDEN', 'the caller is below the project member role'),
    404: noSession,
  },
});

export const readDesktopStatus = describeOperation({
  summary: 'Ask whether a desktop device, or any device of a project, is online',
  description:
    "Answers `connected: false` for anything the caller may not see, so a device or slug of another tenant cannot be probed. Give `deviceId` for one device or `projectSlug` to scan a project's pool and default.",
  responses: { 200: json(desktopConnectedSchema) },
});

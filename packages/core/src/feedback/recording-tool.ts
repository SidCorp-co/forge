// The assistant's read of what a reproduce recorded (REQ-41 BC-19; docs/proposals/chat-first.md
// "Diagnosis"): a feedback item's recordings as their short timelines, never the raw events, read
// through the previews module's own reads so members only ever see them (BC-21). Called with the
// cause and fix the assistant read there, it checks them against the item and answers the proposal
// the chat draws under the reply, whose recommended answer is the item's own issue route, pressed by
// the person as themselves.

import type { FeedbackRefusalCode } from '@forge/contracts/feedback';
import { recordingDiagnosisSchema } from '@forge/contracts/feedback';
import {
  BUILD_THE_FIX,
  RECORDING_TOOL,
  type RecordingToolResult,
} from '@forge/contracts/reproduce';
import { z } from 'zod';
import { principalAgency } from '../issues/index.js';
import { refuser } from '../lib/refusal.js';
import { type ContextScopedMcpToolFactory, zodToMcpSchema } from '../lib/tool.js';
import { recordingsOfFeedback } from '../previews/index.js';
import { detailAs } from './read.js';

/** The newest recordings a turn reads; an item reproduced more often than this is read by its latest. */
const RECORDINGS_READ = 10;

const refuse = refuser<FeedbackRefusalCode>('FEEDBACK_REFUSED');

const input = z.strictObject({
  projectId: z.uuid(),
  feedback: z.string().regex(/^FB-\d{1,9}$/, 'a feedback key such as FB-52'),
  diagnosis: recordingDiagnosisSchema.optional(),
});

export const forgeRecordingTool: ContextScopedMcpToolFactory = (ctx) => ({
  name: RECORDING_TOOL,
  reach: 'project',
  route: '/api/projects',
  grant: 'projects:read',
  description: [
    'What a reproduce of a feedback item recorded: for each recording (newest first) its build (the',
    'sha and the release, which forge_release reads for what changed in it), its state, and its',
    'timeline — pages opened, labelled clicks, typing (never what was typed), console errors and',
    'warnings, and requests that failed, each `at` milliseconds from its start. Raw events are never',
    'read here. Call it when a person asks what went wrong in FB-n, or to diagnose a reported bug.',
    'Then propose ONE cause and ONE fix in short form, from the timeline and the release only (the',
    'product record, not the code): call it again with `diagnosis: { recording, cause, fix }` — the',
    'recording you read it from — and the chat draws your proposal under the reply with its',
    `recommended answer "${BUILD_THE_FIX}", a button the person presses themselves (it files the`,
    "issue whose run builds the fix; the reporter then confirms it in that issue's preview). Say the",
    'cause and the fix in the reply, naming the recording or its timeline for each figure you quote.',
    'No recording yet: say so, and that the Reproduce button on the item opens one.',
  ].join(' '),
  inputSchema: zodToMcpSchema(input),
  handler: async (args): Promise<RecordingToolResult> => {
    const { projectId, feedback: key, diagnosis } = input.parse(args);
    const reader = { userId: ctx.principal.userId, agency: principalAgency(ctx.principal) };
    // members only, refused by the recordings' own name before anything of the item is read
    const recordings = (await recordingsOfFeedback(projectId, key, reader)).slice(
      0,
      RECORDINGS_READ,
    );
    const item = await detailAs(reader, projectId, key);
    if (diagnosis && !recordings.some((r) => r.id === diagnosis.recording)) {
      throw refuse(
        'FEEDBACK_DIAGNOSIS_INVALID',
        `recording ${diagnosis.recording} is not one of ${key}'s${recordings.length ? `; its recordings are ${recordings.map((r) => r.id).join(', ')}` : ', which has none yet'}: name the recording the cause was read from`,
        '/diagnosis/recording',
      );
    }
    return {
      projectId,
      feedback: { key: item.key, title: item.title, phase: item.phase },
      recordings,
      proposal: diagnosis
        ? {
            diagnosis,
            recommended: BUILD_THE_FIX,
            pressable: item.can.triage,
            why: item.can.triage
              ? null
              : `${item.key} reads ${item.phase}: a route is picked by a holder of feedback.approve while the item is new, reopened, or triaged with nothing carrying it`,
          }
        : null,
    };
  },
});

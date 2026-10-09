// The assistant's read of what a reproduce recorded (REQ-41 BC-19; docs/proposals/chat-first.md
// "Diagnosis"): a feedback item's recordings as their short timelines, never the raw events, read
// through the previews module's own reads so members only ever see them (BC-21). Called with the
// cause and fix the assistant read there, it checks them against the item and answers the proposal
// the chat draws under the reply, whose recommended answer is the item's own issue route, pressed by
// the person as themselves.

import { FEEDBACK_TRIAGE_CHECKLIST } from '@forge/contracts/checklist-registry';
import { evaluateChecklist, parseAnswers } from '@forge/contracts/checklists';
import type { FeedbackKind, FeedbackRefusalCode } from '@forge/contracts/feedback';
import { recordingDiagnosisSchema } from '@forge/contracts/feedback';
import { triageAnswersOf, triageAnswersSchema } from '@forge/contracts/feedback-triage';
import {
  BUILD_THE_FIX,
  RECORDING_TOOL,
  type RecordingToolResult,
} from '@forge/contracts/reproduce';
import { z } from 'zod';
import { principalAgency } from '../issues/index.js';
import { refuser } from '../lib/refusal.js';
import { type ContextScopedMcpToolFactory, zodToMcpSchema } from '../lib/tool.js';
import { db } from '../db/client.js';
import { recordingsOfFeedback } from '../previews/index.js';
import { feedbackTriageRecord } from './checklist-record.js';
import { detailAs } from './read.js';

/** The newest recordings a turn reads; an item reproduced more often than this is read by its latest. */
const RECORDINGS_READ = 10;

const refuse = refuser<FeedbackRefusalCode>('FEEDBACK_REFUSED');

const input = z.strictObject({
  projectId: z.uuid(),
  feedback: z.string().regex(/^FB-\d{1,9}$/, 'a feedback key such as FB-52'),
  diagnosis: recordingDiagnosisSchema.optional(),
  /** With a diagnosis: the triage checklist's answers, drafted as the assistant reads the item. */
  answers: triageAnswersSchema.optional(),
});

/**
 * The gaps the issue route a diagnosis proposes would meet: the triage checklist judged as the press
 * will judge it, so a proposal the person could only be refused for is refused here, naming each
 * question, and the assistant drafts the missing answers instead (REQ-34 BC-2).
 */
async function proposalGaps(
  feedbackId: string,
  kind: FeedbackKind,
  answers: unknown,
): Promise<string[]> {
  const parsed = parseAnswers(
    FEEDBACK_TRIAGE_CHECKLIST,
    triageAnswersOf({ kind, route: 'issue', answers }),
  );
  if (!parsed.ok) return parsed.refusals.map((r) => r.detail);
  const record = await feedbackTriageRecord(db, feedbackId);
  return evaluateChecklist(FEEDBACK_TRIAGE_CHECKLIST, { given: parsed.answers, record }).gaps.map(
    (g) => g.detail,
  );
}

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
    'recording you read it from — and `answers`, the triage checklist the press answers: `criterion`',
    '(REQ-n BC-m it violates, or none), `severity`, and `reproduced` (how, citing the recording). The',
    'chat draws your proposal under the reply with its',
    `recommended answer "${BUILD_THE_FIX}", a button the person presses themselves (it files the`,
    "issue whose run builds the fix; the reporter then confirms it in that issue's preview). Say the",
    'cause and the fix in the reply, naming the recording or its timeline for each figure you quote.',
    'No recording yet: say so, and that the Reproduce button on the item opens one.',
  ].join(' '),
  inputSchema: zodToMcpSchema(input),
  handler: async (args): Promise<RecordingToolResult> => {
    const { projectId, feedback: key, diagnosis, answers } = input.parse(args);
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
    if (diagnosis) {
      const gaps = await proposalGaps(item.id, item.kind, answers);
      if (gaps.length > 0) {
        throw refuse(
          'CHECKLIST_INCOMPLETE',
          `the issue route this diagnosis proposes is a triage, and its checklist is not answered: ${gaps.join(' ')} Send them in answers with the diagnosis.`,
          '/answers',
        );
      }
    }
    return {
      projectId,
      feedback: { key: item.key, title: item.title, phase: item.phase },
      recordings,
      proposal: diagnosis
        ? {
            diagnosis,
            answers: answers ?? {},
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

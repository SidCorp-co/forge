// A script schedule's feedback door (REQ-87 BC-2): ctx.feedback.file({ kind, title, body?, severity?,
// signalKey }) files one item on the schedule's own project, or joins the open item with the same
// signal key as an occurrence. The filing is the schedule's: it is filed as the project's own agent
// and seen on the schedule, never as the person who saved it. A payload that does not fit is refused
// by name, and nothing is filed. Every filing, refused or not, is kept for the fire's record.

import { FEEDBACK_LIMITS, FEEDBACK_REPORT_KINDS } from '@forge/contracts/feedback';
import { FEEDBACK_SEVERITIES } from '@forge/contracts/feedback-terms';
import {
  SCRIPT_FEEDBACK_CAP,
  SCRIPT_FILING_SHAPE,
  type ScriptFiling,
} from '@forge/contracts/script-sandbox';
import { z } from 'zod';
import type { ReadOutcome, ScriptFiler } from '../sandbox/index.js';
import { schedulesPorts } from './ports.js';

export const scriptFilingSchema = z.strictObject({
  kind: z.enum(FEEDBACK_REPORT_KINDS),
  title: z.string().trim().min(1).max(FEEDBACK_LIMITS.title),
  body: z.string().max(FEEDBACK_LIMITS.body).optional(),
  severity: z.enum(FEEDBACK_SEVERITIES).optional(),
  signalKey: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .regex(/^\S+$/, 'a signal key is one word with no space, such as epod:cdc-down'),
});
export type ScriptFilingRequest = z.infer<typeof scriptFilingSchema>;

const REFUSED = 'SCRIPT_FEEDBACK_REFUSED';

const refusedOutcome = (message: string): ReadOutcome => ({
  ok: false,
  name: 'ScriptFeedbackRefused',
  code: REFUSED,
  message: `${REFUSED}: ${message}. Nothing was filed.`,
});

/** The ctx.feedback.file host of one firing of `schedule`, on its own project. */
export function openFiler(args: {
  projectId: string;
  schedule: { id: string; name: string };
  fireId: string;
}): { file: ScriptFiler; filings(): ScriptFiling[] } {
  const log: ScriptFiling[] = [];
  const file: ScriptFiler = async (payload) => {
    const key =
      payload && typeof payload === 'object' && typeof (payload as { signalKey?: unknown }).signalKey === 'string'
        ? String((payload as { signalKey: string }).signalKey).slice(0, 200)
        : '';
    const refuse = (message: string) => {
      log.push({ signalKey: key, key: null, created: false, refused: REFUSED });
      return refusedOutcome(message);
    };
    if (log.length >= SCRIPT_FEEDBACK_CAP) {
      return refuse(`this firing has filed ${SCRIPT_FEEDBACK_CAP} times, its cap`);
    }
    const parsed = scriptFilingSchema.safeParse(payload);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const at = issue?.path.length ? issue.path.join('.') : 'the payload';
      return refuse(
        `ctx.feedback.file takes ${SCRIPT_FILING_SHAPE}; ${at}: ${issue?.message ?? 'does not fit'}`,
      );
    }
    const filed = await schedulesPorts().fileScriptFeedback({
      projectId: args.projectId,
      schedule: args.schedule,
      fireId: args.fireId,
      request: parsed.data,
    });
    if (!filed.ok) return refuse(filed.why);
    log.push({ signalKey: parsed.data.signalKey, key: filed.key, created: filed.created });
    return { ok: true, body: { key: filed.key, created: filed.created } };
  };
  return { file, filings: () => log.map((f) => ({ ...f })) };
}

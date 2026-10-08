// The narrative of a template report a schedule stores: one model call, after the template's runs are
// stored, writes the slots from the template's guidance and the frames of this fire's own runs, and
// nothing else from the project. The answer is judged by `checkTemplateNarrative` (word caps, declared
// slots only, no number the runs did not return); a refused answer gets one retry that carries the
// refusal. The call goes through `completeOnce`, so the deployment's provider and the project's data
// policy apply exactly as they do to a chat turn. Whatever happens is kept on the report and named in
// the notice: written, retried, or not written with the reason, never an empty slot in silence.

import { contentLanguageBlock } from '@forge/contracts/content-language';
import type { ActorAgency } from '@forge/contracts/permissions';
import type { ReportDocument, TemplateNarrativeSlot } from '@forge/contracts/report-templates';
import type { StatusReportNarrative } from '@forge/contracts/status-reports';
import { recordModelCallUsage } from '../agent-sessions/index.js';
import {
  type ChatMessage,
  type ChatStreamUsage,
  type CompletionAnswer,
  completeOnce,
} from '../integrations/llm/index.js';
import { logger } from '../lib/logger.js';
import { isRefusal } from '../lib/refusal.js';
import { readContentLanguage } from '../project-config/index.js';
import { statusReportsPorts } from './ports.js';

/** A hung provider cannot hold a fire longer than this per call. */
const CALL_TIMEOUT_MS = 60_000;
const REASON_DETAIL_CHARS = 300;
/** A provider error that says the account or key ran out, rather than that the call broke. */
const OVER_BUDGET = /budget|quota|rate.?limit|insufficient|credit|\b429\b|too many requests/i;

interface Slot {
  slot: TemplateNarrativeSlot;
  guidance: string;
  maxWords: number;
}

export interface FireNarrativeArgs {
  projectId: string;
  scheduleId: string;
  title: string;
  document: ReportDocument;
  slots: readonly Slot[];
  userId: string;
  agency: ActorAgency;
}

/** The instructions: what the call is given (and that it is given nothing else), the answer's shape, the language. */
export function narrativeSystemPrompt(
  title: string,
  slots: readonly Slot[],
  language: Parameters<typeof contentLanguageBlock>[0],
): string {
  const keys = slots.map((s) => s.slot).join(', ');
  return [
    `You write the narrative of one scheduled "${title}" report: ${keys}.`,
    "Your only input is the template's guidance for each slot and the rows of this report's own query runs, both below. Nothing else from the project is given to you, so state nothing they do not hold.",
    '',
    'Rules:',
    `- Answer with one JSON object and nothing else. Its keys are exactly: ${keys}. Each value is plain prose.`,
    ...slots.map((s) => `- "${s.slot}" is at most ${s.maxWords} words.`),
    '- Every number you write appears in a row below, as it appears there. Write no dates, ids, versions, sums or percentages you worked out yourself.',
    '- Where the rows do not say enough for a slot, say so in words.',
    '',
    contentLanguageBlock(language, 'artifact'),
  ].join('\n');
}

/** The input: each slot's guidance, then each run's fields and rows. No run id, time or param, which are not figures. */
export function narrativeInput(document: ReportDocument, slots: readonly Slot[]): string {
  const parts = ['## Slots', ...slots.map((s) => `- ${s.slot}: ${s.guidance}`), '', '## Runs'];
  for (const run of document.runs) {
    parts.push(
      '',
      `### Query ${run.queryId}`,
      `Fields: ${run.frame.fields.map((f) => `${f.name} (${f.type})`).join(', ')}`,
      `Rows: ${JSON.stringify(run.frame.rows)}`,
    );
  }
  return parts.join('\n');
}

/** The answer's slots, or why it is not one JSON object of strings. */
function parseAnswer(
  text: string,
): { ok: true; narrative: Record<string, string> } | { ok: false; why: string } {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  const shape =
    'the answer is not one JSON object whose values are the slots as plain strings; answer with that object and nothing else';
  if (start < 0 || end <= start) return { ok: false, why: shape };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return { ok: false, why: shape };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    return { ok: false, why: shape };
  const entries = Object.entries(parsed as Record<string, unknown>);
  if (entries.some(([, v]) => typeof v !== 'string')) return { ok: false, why: shape };
  return { ok: true, narrative: Object.fromEntries(entries) as Record<string, string> };
}

const trimmed = (text: string) =>
  text.length > REASON_DETAIL_CHARS ? `${text.slice(0, REASON_DETAIL_CHARS)}…` : text;

/** Why a call that did not answer left the narrative unwritten; the provider's own text goes to the log, not the notice. */
function missReason(answer: Extract<CompletionAnswer, { ok: false }>): string {
  if (answer.miss === 'withheld') {
    return "the project's data policy forbids sending its data to a model, so no model was asked";
  }
  if (answer.miss === 'unconfigured') return 'no chat model is configured on this instance';
  if (OVER_BUDGET.test(answer.detail)) return 'the model is over its budget or rate limit';
  return 'the model call failed';
}

/** The answer judged against the template's own runs: the document with it set, or the refusal's text. */
async function judged(
  args: FireNarrativeArgs,
  text: string,
): Promise<{ ok: true; document: ReportDocument } | { ok: false; why: string }> {
  const parsed = parseAnswer(text);
  if (!parsed.ok) return parsed;
  try {
    const document = await statusReportsPorts().checkTemplateNarrative({
      projectId: args.projectId,
      templateId: args.document.templateId,
      runIds: args.document.runs.map((r) => r.runId),
      narrative: parsed.narrative,
      userId: args.userId,
      agency: args.agency,
    });
    return { ok: true, document };
  } catch (err) {
    if (isRefusal(err)) return { ok: false, why: err.message };
    throw err;
  }
}

/**
 * Writes the fire's narrative: the document to store, with the slots set or left empty, and how it
 * came to be. Each call's usage is recorded with the model that answered it.
 */
export async function writeFireNarrative(
  args: FireNarrativeArgs,
): Promise<{ document: ReportDocument; narrative: StatusReportNarrative }> {
  const scope = {
    surface: 'conversation' as const,
    projectId: args.projectId,
    what: `the narrative of schedule ${args.scheduleId}'s ${args.document.templateId} report`,
  };
  const language = await readContentLanguage(args.projectId);
  const messages: ChatMessage[] = [
    { role: 'system', content: narrativeSystemPrompt(args.title, args.slots, language) },
    { role: 'user', content: narrativeInput(args.document, args.slots) },
  ];
  const spent: { model: string; usage: ChatStreamUsage }[] = [];
  let calls = 0;
  let model: string | null = null;
  const notWritten = (reason: string) => ({
    document: args.document,
    narrative: { path: 'not_written' as const, reason, model, calls },
  });
  try {
    for (const path of ['written', 'retried'] as const) {
      const answer = await completeOnce(scope, messages, {
        temperature: 0,
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
      if (answer.model) {
        calls++;
        model = answer.model;
      }
      if (!answer.ok) {
        logger.warn(
          { scheduleId: args.scheduleId, miss: answer.miss, detail: answer.detail },
          'status-reports: the narrative call did not answer',
        );
        return notWritten(missReason(answer));
      }
      spent.push({ model: answer.model, usage: answer.usage });
      const verdict = await judged(args, answer.text);
      if (verdict.ok) {
        return { document: verdict.document, narrative: { path, reason: null, model, calls } };
      }
      if (path === 'retried') {
        return notWritten(`the model's narrative was refused twice (${trimmed(verdict.why)})`);
      }
      messages.push(
        { role: 'assistant', content: answer.text },
        {
          role: 'user',
          content: `That narrative was refused: ${verdict.why}\nWrite it again by the same rules, from the same rows, as one JSON object.`,
        },
      );
    }
    throw new Error('status-reports: the narrative loop ended without an outcome');
  } finally {
    await recordSpend(args.projectId, spent);
  }
}

async function recordSpend(
  projectId: string,
  spent: readonly { model: string; usage: ChatStreamUsage }[],
): Promise<void> {
  const last = spent.at(-1);
  if (!last) return;
  const sum = (key: keyof ChatStreamUsage) => spent.reduce((n, s) => n + (s.usage[key] ?? 0), 0);
  const cached = sum('cachedPromptTokens');
  try {
    await recordModelCallUsage({
      projectId,
      model: last.model,
      inputTokens: Math.max(0, sum('promptTokens') - cached),
      outputTokens: sum('completionTokens'),
      cacheReadTokens: cached,
      requestCount: spent.length,
      recordedAt: new Date(),
    });
  } catch (err) {
    logger.warn(
      { err, projectId },
      'status-reports: the usage of the narrative calls was not recorded',
    );
  }
}

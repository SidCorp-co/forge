// The narrative of a template run: one model call, after the template's runs are kept, writes the
// slots from the template's guidance and a one-line finding for each block, from what this run's
// blocks show of its own runs and nothing else from the project. The answer is judged by
// `checkTemplateNarrative` (word caps, declared slots only, no number its blocks do not show, a
// finding holding no number its own block does not show); a refused answer gets one retry that
// carries the refusal. The call goes through `completeOnce`, so the deployment's provider and the
// project's data policy apply exactly as they do to a chat turn. Every door a template is run
// through (the REST route, the chat's forge_template, a schedule's fire) gets the narrative this
// writes, and how it came to be: written, retried, or not written with the reason, never an empty
// slot in silence (REQ-32 BC-7).

import { contentLanguageBlock } from '@forge/contracts/content-language';
import {
  FINDING_MAX_WORDS,
  type ReportDocument,
  type TemplateNarrativeSlot,
} from '@forge/contracts/report-templates';
import type { StatusReportNarrative } from '@forge/contracts/status-reports';
import { shownFrame } from '@forge/contracts/visual-blocks';
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

/** A hung provider cannot hold a run longer than this per call. */
const CALL_TIMEOUT_MS = 60_000;
const REASON_DETAIL_CHARS = 300;
/** A provider error that says the account or key ran out, rather than that the call broke. */
const OVER_BUDGET = /budget|quota|rate.?limit|insufficient|credit|\b429\b|too many requests/i;

/** How a run's narrative came to be: the one shape a schedule keeps and every door answers. */
export type NarrativeOutcome = StatusReportNarrative;

export interface Slot {
  slot: TemplateNarrativeSlot;
  guidance: string;
  maxWords: number;
}

/** What the narrative is judged by: `templates.ts:checkTemplateNarrative`, handed in so this file reads no run itself. */
export type NarrativeJudge = (args: {
  narrative: Partial<Record<TemplateNarrativeSlot, string>>;
  findings: readonly string[];
}) => ReportDocument | Promise<ReportDocument>;

export interface TemplateNarrativeArgs {
  projectId: string;
  /** What the run is, for the model scope and the log: "the progress report", "schedule X's progress report". */
  what: string;
  title: string;
  document: ReportDocument;
  slots: readonly Slot[];
  judge: NarrativeJudge;
}

/** The instructions: what the call is given (and that it is given nothing else), the answer's shape, the language. */
export function narrativeSystemPrompt(
  title: string,
  slots: readonly Slot[],
  blocks: number,
  language: Parameters<typeof contentLanguageBlock>[0],
): string {
  const keys = slots.map((s) => s.slot).join(', ');
  return [
    `You write the narrative of one "${title}" report: ${keys}, and a one-line finding for each of its ${blocks} block(s).`,
    "Your only input is the template's guidance for each slot and what each of this report's blocks shows, both below. Nothing else from the project is given to you, so state nothing they do not hold.",
    '',
    'Rules:',
    `- Answer with one JSON object and nothing else. Its keys are exactly: ${keys}, findings. Each slot is plain prose; "findings" is an array of ${blocks} string(s), one per block in the order below.`,
    ...slots.map((s) => `- "${s.slot}" is at most ${s.maxWords} words.`),
    `- A finding is one line of at most ${FINDING_MAX_WORDS} words saying what that block's own rows show: a change, a peak, an outlier, not a restatement of its title. Every number in it appears in that block's rows.`,
    '- Every number you write appears in a row below, as it appears there. Write no dates, ids, versions, sums or percentages you worked out yourself.',
    '- Where the rows do not say enough for a slot or a finding, say so in words.',
    '',
    contentLanguageBlock(language, 'artifact'),
  ].join('\n');
}

/**
 * The input: each slot's guidance, then each block's fields and rows as it shows them, numbered as
 * the findings are, since the narrative is read beside the blocks and is held to them. No run id,
 * time or param, which are not figures.
 */
export function narrativeInput(document: ReportDocument, slots: readonly Slot[]): string {
  const parts = ['## Slots', ...slots.map((s) => `- ${s.slot}: ${s.guidance}`), '', '## Blocks'];
  const queryOf = new Map(document.runs.map((r) => [r.runId, r.queryId]));
  for (const [i, block] of document.blocks.entries()) {
    const frame = shownFrame(block);
    const runId = block.source && 'runId' in block.source ? block.source.runId : null;
    const query = runId ? queryOf.get(runId) : undefined;
    parts.push(
      '',
      `### ${block.kind}${block.title ? ` "${block.title}"` : ''}${query ? ` (query ${query})` : ''}, finding ${i + 1}`,
      ...(frame
        ? [
            `Fields: ${frame.fields.map((f) => `${f.name} (${f.type})`).join(', ')}`,
            `Rows: ${JSON.stringify(frame.rows)}`,
          ]
        : ['It shows no rows.']),
    );
  }
  return parts.join('\n');
}

type Parsed =
  | { ok: true; narrative: Record<string, string>; findings: string[] }
  | { ok: false; why: string };

/** The answer's slots and findings, or why it is not one JSON object of strings and a findings array of strings. */
function parseAnswer(text: string): Parsed {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  const shape =
    'the answer is not one JSON object whose values are the slots as plain strings and "findings" as an array of strings; answer with that object and nothing else';
  if (start < 0 || end <= start) return { ok: false, why: shape };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return { ok: false, why: shape };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    return { ok: false, why: shape };
  const { findings = [], ...slots } = parsed as Record<string, unknown>;
  if (!Array.isArray(findings) || findings.some((f) => typeof f !== 'string'))
    return { ok: false, why: shape };
  const entries = Object.entries(slots);
  if (entries.some(([, v]) => typeof v !== 'string')) return { ok: false, why: shape };
  return {
    ok: true,
    narrative: Object.fromEntries(entries) as Record<string, string>,
    findings: findings as string[],
  };
}

const trimmed = (text: string) =>
  text.length > REASON_DETAIL_CHARS ? `${text.slice(0, REASON_DETAIL_CHARS)}…` : text;

/** Why a call that did not answer left the narrative unwritten; the provider's own text goes to the log, not the reader. */
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
  args: TemplateNarrativeArgs,
  text: string,
): Promise<{ ok: true; document: ReportDocument } | { ok: false; why: string }> {
  const parsed = parseAnswer(text);
  if (!parsed.ok) return parsed;
  const blocks = args.document.blocks.length;
  if (parsed.findings.length !== blocks) {
    return {
      ok: false,
      why: `"findings" holds ${parsed.findings.length} finding(s), and the report draws ${blocks} block(s); give one finding per block, in the order the blocks are listed`,
    };
  }
  try {
    return {
      ok: true,
      document: await args.judge({ narrative: parsed.narrative, findings: parsed.findings }),
    };
  } catch (err) {
    if (isRefusal(err)) return { ok: false, why: err.message };
    throw err;
  }
}

/**
 * Writes a run's narrative and findings: the document with them set, or left empty, and how it came
 * to be. Each call's usage is recorded with the model that answered it.
 */
export async function writeTemplateNarrative(
  args: TemplateNarrativeArgs,
): Promise<{ document: ReportDocument; narrative: NarrativeOutcome }> {
  const scope = {
    surface: 'conversation' as const,
    projectId: args.projectId,
    what: `the narrative of ${args.what}`,
  };
  const language = await readContentLanguage(args.projectId);
  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: narrativeSystemPrompt(args.title, args.slots, args.document.blocks.length, language),
    },
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
          { what: args.what, miss: answer.miss, detail: answer.detail },
          'reports: the narrative call did not answer',
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
    throw new Error('reports: the narrative loop ended without an outcome');
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
    logger.warn({ err, projectId }, 'reports: the usage of the narrative calls was not recorded');
  }
}

/**
 * ISS-1054 — the sidecar judge: a second model, on a different family from the one under test,
 * asked the one question the rules cannot answer — was this person served. Its verdict is stored
 * beside the modes and never read into `pass`, pass^k or a mode: the judge never rescues a failed
 * check. An answer the parser cannot read is an error on the row, never a guessed verdict.
 */

import { createOpenAIProvider } from '../providers/openai.js';
import type { ChatMessage, ChatProvider } from '../providers/types.js';
import type { FetchLike } from './client.js';
import type { FailureMode } from './grade.js';
import type { ToolCall } from './trail.js';

/** The block the judge reads that the assistant never saw: the fixtures the benchmark read and the earlier turns. */
export const REFERENCE_HEADER =
  'What the benchmark read from the project and the earlier turns; the assistant did not see this block:';

export interface JudgeInput {
  /** One sentence the task adds to the generic rule (ISS-1061). */
  rubric?: string;
  /** The facts the judge holds against the reply: filled fixtures and earlier turns (ISS-1061, codex F3). */
  reference?: string;
  query: string;
  reply: string | null;
  /** Each tool call rendered for a reader: `forge issue --status open`, with ` (error)` when the tool errored. */
  calls: string[];
  error: string | null;
}

export const SERVED = ['yes', 'partial', 'no'] as const;
export type Served = (typeof SERVED)[number];

export interface Verdict {
  intent: string;
  served: Served;
  reason: string;
  quote: string;
}

export type JudgeResult = Verdict | { error: string };

export const isVerdict = (r: JudgeResult): r is Verdict => !('error' in r);

export class JudgeRefusal extends Error {}
export class JudgeParseError extends Error {}

export const NO_REPLY = 'no reply was delivered';
export const ASKED_HEADER = 'Person asked:';
export const CALLS_HEADER = 'Tool calls the assistant made:';
export const ERROR_HEADER = 'Error recorded on the turn:';
export const REPLIED_HEADER = 'Assistant replied:';
const KEYS = ['intent', 'served', 'reason', 'quote'] as const;

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const head = (s: string): string => (s.length > 80 ? `${s.slice(0, 80)}…` : s);
const fold = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** The calls of an attempt as the judge reads them. */
export function callLines(calls: ToolCall[]): string[] {
  return calls.map((c) => {
    const text = c.argv ? `forge ${c.argv.join(' ')}` : c.name;
    return c.isError ? `${text} (error)` : text;
  });
}

/** Pure: the two messages the judge is sent. */
export function judgeMessages(input: JudgeInput): ChatMessage[] {
  const system = [
    'You judge one exchange between a person and a project assistant. Decide from the reply alone whether the assistant served what the person asked; the tool calls say what it looked at, not what it found.',
    'Answer with one JSON object and nothing else, with exactly these keys:',
    '"intent": one line saying what the person wanted;',
    '"served": "yes" when the reply gives the person what they asked for, "partial" when it gives some of it or asks a fair question back, "no" when it does not;',
    '"reason": one sentence;',
    '"quote": a span copied exactly from the reply that the reason rests on, or "" when there is no reply or nothing in it to rest on.',
    ...(input.rubric
      ? [`For this exchange, "served" is read by this rule as well: ${input.rubric}`]
      : []),
  ].join('\n');
  const calls = input.calls.length > 0 ? input.calls.map((c) => `- ${c}`).join('\n') : '- none';
  const user = [
    `${ASKED_HEADER}\n${input.query}`,
    `${CALLS_HEADER}\n${calls}`,
    `${ERROR_HEADER} ${input.error ?? 'none'}`,
    `${REPLIED_HEADER}\n${input.reply ?? NO_REPLY}`,
    ...(input.reference ? [`${REFERENCE_HEADER}\n${input.reference}`] : []),
  ].join('\n\n');
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

const unwrap = (text: string): string => {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  return (fenced?.[1] ?? text).trim();
};

/** Pure: the judge's text as a verdict, or a refusal naming what is wrong with it. */
export function parseVerdict(text: string, reply: string | null): Verdict {
  let parsed: unknown;
  try {
    parsed = JSON.parse(unwrap(text));
  } catch {
    throw new JudgeParseError(`judge answer is not JSON: ${head(fold(text))}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
    throw new JudgeParseError('judge answer is not an object');
  const obj = parsed as Record<string, unknown>;
  for (const key of KEYS) {
    if (typeof obj[key] !== 'string') throw new JudgeParseError(`judge answer lacks ${key}`);
  }
  const served = obj.served as string;
  if (!(SERVED as readonly string[]).includes(served))
    throw new JudgeParseError(`judge served is ${head(served)}, not yes, partial or no`);
  const quote = obj.quote as string;
  if (reply === null) {
    if (quote !== '') throw new JudgeParseError('judge quoted a reply that was never delivered');
  } else if (quote !== '' && !fold(reply).includes(fold(quote))) {
    throw new JudgeParseError(`judge quote is not in the reply: ${head(fold(quote))}`);
  }
  return {
    intent: obj.intent as string,
    served: served as Served,
    reason: obj.reason as string,
    quote,
  };
}

export interface Tally {
  judged: number;
  yes: number;
  partial: number;
  no: number;
  unreadable: number;
}

export function tally(results: JudgeResult[]): Tally {
  const t: Tally = { judged: results.length, yes: 0, partial: 0, no: 0, unreadable: 0 };
  for (const r of results) {
    if (isVerdict(r)) t[r.served] += 1;
    else t.unreadable += 1;
  }
  return t;
}

/** Whether the judge agrees with the rules where both can see: rule-failed rows it called `no`, clean rows it called `yes`. */
export interface Agreement {
  ruleFailed: { judged: number; no: number };
  clean: { judged: number; yes: number };
}

const RULE_FAILED: readonly FailureMode[] = ['fallback_sent', 'unanswered'];

export function agreement(
  rows: ReadonlyArray<{ modes: readonly FailureMode[]; judge: JudgeResult | undefined }>,
): Agreement {
  const a: Agreement = { ruleFailed: { judged: 0, no: 0 }, clean: { judged: 0, yes: 0 } };
  for (const row of rows) {
    if (!row.judge || !isVerdict(row.judge)) continue;
    if (row.modes.some((m) => RULE_FAILED.includes(m))) {
      a.ruleFailed.judged += 1;
      if (row.judge.served === 'no') a.ruleFailed.no += 1;
    } else if (row.modes.length === 0) {
      a.clean.judged += 1;
      if (row.judge.served === 'yes') a.clean.yes += 1;
    }
  }
  return a;
}

export const tallyLine = (t: Tally): string =>
  `judge yes ${t.yes}/${t.judged}, partial ${t.partial}/${t.judged}, no ${t.no}/${t.judged}, unreadable ${t.unreadable}/${t.judged}`;

export const agreementLine = (a: Agreement): string =>
  `agreement: rule-failed rows judged no ${a.ruleFailed.no}/${a.ruleFailed.judged}, clean rows judged yes ${a.clean.yes}/${a.clean.judged}`;

export interface Judge {
  readonly model: string;
  judge(input: JudgeInput): Promise<JudgeResult>;
}

export interface JudgeOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  fetch: FetchLike;
  timeoutMs?: number;
  /** Backoff between the provider's retries; tests pass [0]. */
  retryDelaysMs?: number[];
}

/** One request per call through the provider given, at temperature 0; every failure is `{ error }`, never a throw. */
export function createJudgeFromProvider(
  provider: Pick<ChatProvider, 'stream'>,
  model: string,
  opts: { timeoutMs?: number } = {},
): Judge {
  return {
    model,
    async judge(input) {
      const chunks: string[] = [];
      try {
        const stream = provider.stream({
          model,
          messages: judgeMessages(input),
          temperature: 0,
          signal: AbortSignal.timeout(opts.timeoutMs ?? 120_000),
        });
        for await (const event of stream) {
          if (event.type === 'chunk') chunks.push(event.text);
          else if (event.type === 'error') return { error: `judge stream: ${event.message}` };
        }
      } catch (err) {
        return { error: `judge request: ${errorText(err)}` };
      }
      try {
        return parseVerdict(chunks.join(''), input.reply);
      } catch (err) {
        return { error: errorText(err) };
      }
    },
  };
}

/** The judge over an OpenAI-wire endpoint named by URL and key, as the CLI is given one. */
export function createJudge(o: JudgeOptions): Judge {
  const provider = createOpenAIProvider({
    baseUrl: o.baseUrl,
    apiKey: o.apiKey,
    defaultModel: o.model,
    fetchImpl: o.fetch as unknown as typeof fetch,
    ...(o.retryDelaysMs ? { retryDelaysMs: o.retryDelaysMs } : {}),
  });
  return createJudgeFromProvider(provider, o.model, { timeoutMs: o.timeoutMs ?? 120_000 });
}

/** The judge from the environment, refused by name when a variable is absent. */
export function judgeFromEnv(
  env: Record<string, string | undefined>,
  model: string,
  fetch: FetchLike,
): Judge {
  const baseUrl = env.FORGE_BENCH_JUDGE_URL;
  const apiKey = env.FORGE_BENCH_JUDGE_KEY;
  if (!baseUrl || !apiKey)
    throw new JudgeRefusal(
      'no judge credential: set FORGE_BENCH_JUDGE_URL and FORGE_BENCH_JUDGE_KEY (read from the environment only)',
    );
  return createJudge({ baseUrl, apiKey, model, fetch });
}

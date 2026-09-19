/**
 * Minimal non-streaming completion for the system-job "fast model" — memory-v2
 * intelligence (extraction, consolidation) and agent-session auto-titling. One
 * backend, LITELLM_* (any OpenAI-compatible /chat/completions), from GLOBAL env
 * so this stays independent of the per-project chat stack; LITELLM_FAST_MODEL
 * lets it run a cheaper model than the chat default on the same proxy. A null
 * return means skip this run, always preceded by a log saying which of "no
 * backend", "the call failed" and "the budget ran out" it was.
 */
import { env } from '../config/env.js';
import { openAiCompatUrl } from '../lib/openai-compat-url.js';
import { logger } from '../logger.js';

/** Hard cap so a hung endpoint can never wedge a pg-boss worker. */
const COMPLETION_TIMEOUT_MS = 60_000;

function reasoningControl(): Record<string, unknown> {
  return { reasoning_effort: env.LITELLM_FAST_REASONING_EFFORT };
}

/** The model every system job runs on unless a caller names another. */
export function fastModelName(): string {
  return env.LITELLM_FAST_MODEL ?? env.LITELLM_MODEL;
}

const EXHAUSTED_RETRY_TOKENS = 4000;

interface CompletionChoice {
  finish_reason?: string | null;
  message?: { content?: string | null };
}

/** A 400 rejecting the request SHAPE, the one case worth retrying without the field. */
function rejectsReasoningEffort(status: number, body: string): boolean {
  return (
    status === 400 && /reasoning_effort|unsupported|unrecognized|unknown.{0,20}param/i.test(body)
  );
}

async function postCompletion(
  prompt: string,
  maxTokens: number,
  model: string,
  extra: Record<string, unknown>,
): Promise<Response | null> {
  try {
    return await fetch(openAiCompatUrl(env.LITELLM_API_URL ?? '', 'chat/completions'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(env.LITELLM_API_KEY ? { Authorization: `Bearer ${env.LITELLM_API_KEY}` } : {}),
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: maxTokens,
        temperature: 0,
        ...extra,
      }),
      signal: AbortSignal.timeout(COMPLETION_TIMEOUT_MS),
    });
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'memory.llm: completion request failed');
    return null;
  }
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

async function readChoice(response: Response): Promise<CompletionChoice | null> {
  try {
    const data = (await response.json()) as { choices?: CompletionChoice[] };
    return data.choices?.[0] ?? null;
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'memory.llm: completion body unreadable');
    return null;
  }
}

async function callLiteLlm(
  prompt: string,
  maxTokens: number,
  model: string,
): Promise<string | null> {
  let control: Record<string, unknown> = reasoningControl();
  let budget = maxTokens;
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await postCompletion(prompt, budget, model, control);
    if (!response) return null;
    if (!response.ok) {
      const body = response.status === 400 ? await safeText(response) : '';
      if (
        attempt === 0 &&
        'reasoning_effort' in control &&
        rejectsReasoningEffort(response.status, body)
      ) {
        logger.info('memory.llm: endpoint rejected reasoning_effort, retrying without it');
        control = {};
        continue;
      }
      logger.warn({ status: response.status }, 'memory.llm: completion call failed');
      return null;
    }
    const choice = await readChoice(response);
    const text = choice?.message?.content?.trim() || null;
    if (text) return text;
    if (choice?.finish_reason === 'length' && attempt === 0) {
      logger.warn(
        { budget, retryBudget: EXHAUSTED_RETRY_TOKENS, model },
        'memory.llm: token budget exhausted before any output, retrying once with a larger budget',
      );
      budget = EXHAUSTED_RETRY_TOKENS;
      continue;
    }
    logger.warn(
      { finishReason: choice?.finish_reason ?? null, budget, model },
      'memory.llm: completion returned no text',
    );
    return null;
  }
  return null;
}

export async function callFastModel(
  prompt: string,
  maxTokens: number,
  opts?: { model?: string },
): Promise<string | null> {
  if (env.LITELLM_API_URL) return callLiteLlm(prompt, maxTokens, opts?.model ?? fastModelName());
  return null;
}

/** True when the fast-model backend is configured. */
export function fastModelConfigured(): boolean {
  return Boolean(env.LITELLM_API_URL);
}

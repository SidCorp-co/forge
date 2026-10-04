/**
 * Minimal non-streaming completion for the system-job "fast model" — memory-v2
 * intelligence (extraction, consolidation) and agent-session auto-titling. One
 * backend, LITELLM_* (any OpenAI-compatible /chat/completions), from GLOBAL env
 * so this stays independent of the per-project chat stack; LITELLM_FAST_MODEL
 * lets it run a cheaper model than the chat default on the same proxy. A null
 * return means skip this run, always preceded by a log saying which of "no
 * backend", "the call failed", "the budget ran out" and "the data policy withholds it" it was.
 */
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { generateText } from 'ai';
import { env } from '../../config/env.js';
import { type EgressScope, egressScoped } from '../../lib/data-egress.js';
import { openAiCompatBaseUrl } from '../../lib/openai-compat-url.js';
import { logger } from '../../observability/logger.js';
import { badRequestBody, errorText } from './ai-sdk.js';

/** Hard cap so a hung endpoint can never wedge a pg-boss worker. */
const COMPLETION_TIMEOUT_MS = 60_000;

/** The model every system job runs on unless a caller names another. */
export function fastModelName(): string {
  return env.LITELLM_FAST_MODEL ?? env.LITELLM_MODEL;
}

const EXHAUSTED_RETRY_TOKENS = 4000;
const PROVIDER = 'litellm';

/** A 400 rejecting the request SHAPE, the one case worth retrying without the field. */
const REJECTS_REASONING_EFFORT = /reasoning_effort|unsupported|unrecognized|unknown.{0,20}param/i;

type Completion = { text: string; finishReason: string } | { failed: string; body: string | null };

async function complete(
  prompt: string,
  maxTokens: number,
  model: string,
  reasoningEffort: string | undefined,
): Promise<Completion> {
  const sdk = createOpenAICompatible({
    name: PROVIDER,
    baseURL: openAiCompatBaseUrl(env.LITELLM_API_URL ?? ''),
    ...(env.LITELLM_API_KEY ? { apiKey: env.LITELLM_API_KEY } : {}),
  });
  try {
    const out = await generateText({
      model: sdk.chatModel(model),
      prompt,
      maxOutputTokens: maxTokens,
      temperature: 0,
      maxRetries: 0,
      abortSignal: AbortSignal.timeout(COMPLETION_TIMEOUT_MS),
      ...(reasoningEffort ? { providerOptions: { [PROVIDER]: { reasoningEffort } } } : {}),
    });
    return { text: out.text, finishReason: out.finishReason };
  } catch (err) {
    return { failed: errorText(err, 'memory.llm'), body: badRequestBody(err) };
  }
}

async function callLiteLlm(
  prompt: string,
  maxTokens: number,
  model: string,
): Promise<string | null> {
  let reasoningEffort: string | undefined = env.LITELLM_FAST_REASONING_EFFORT;
  let budget = maxTokens;
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await complete(prompt, budget, model, reasoningEffort);
    if ('failed' in result) {
      if (
        attempt === 0 &&
        reasoningEffort &&
        result.body !== null &&
        REJECTS_REASONING_EFFORT.test(result.body)
      ) {
        logger.info('memory.llm: endpoint rejected reasoning_effort, retrying without it');
        reasoningEffort = undefined;
        continue;
      }
      logger.warn({ err: result.failed }, 'memory.llm: completion call failed');
      return null;
    }
    const text = result.text.trim() || null;
    if (text) return text;
    if (result.finishReason === 'length' && attempt === 0) {
      logger.warn(
        { budget, retryBudget: EXHAUSTED_RETRY_TOKENS, model },
        'memory.llm: token budget exhausted before any output, retrying once with a larger budget',
      );
      budget = EXHAUSTED_RETRY_TOKENS;
      continue;
    }
    logger.warn(
      { finishReason: result.finishReason, budget, model },
      'memory.llm: completion returned no text',
    );
    return null;
  }
  return null;
}

export async function callFastModel(
  scope: EgressScope,
  prompt: string,
  maxTokens: number,
  opts?: { model?: string },
): Promise<string | null> {
  if (!env.LITELLM_API_URL) return null;
  const sent = await egressScoped(scope, prompt);
  if (!sent.ok) {
    logger.warn(
      { code: sent.refusal.code, surface: scope.surface },
      'llm.fast-model: the data policy withholds this prompt',
    );
    return null;
  }
  return callLiteLlm(sent.text, maxTokens, opts?.model ?? fastModelName());
}

/** True when the fast-model backend is configured. */
export function fastModelConfigured(): boolean {
  return Boolean(env.LITELLM_API_URL);
}

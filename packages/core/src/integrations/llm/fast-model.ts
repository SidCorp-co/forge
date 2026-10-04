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
import { generateText, NoObjectGeneratedError, NoOutputGeneratedError, Output } from 'ai';
import type { z } from 'zod';
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

function fastModelSdk() {
  return createOpenAICompatible({
    name: PROVIDER,
    baseURL: openAiCompatBaseUrl(env.LITELLM_API_URL ?? ''),
    ...(env.LITELLM_API_KEY ? { apiKey: env.LITELLM_API_KEY } : {}),
  });
}

function callSettings(maxTokens: number, reasoningEffort: string | undefined) {
  return {
    maxOutputTokens: maxTokens,
    temperature: 0,
    maxRetries: 0,
    abortSignal: AbortSignal.timeout(COMPLETION_TIMEOUT_MS),
    ...(reasoningEffort ? { providerOptions: { [PROVIDER]: { reasoningEffort } } } : {}),
  };
}

async function complete(
  prompt: string,
  maxTokens: number,
  model: string,
  reasoningEffort: string | undefined,
): Promise<Completion> {
  try {
    const out = await generateText({
      model: fastModelSdk().chatModel(model),
      prompt,
      ...callSettings(maxTokens, reasoningEffort),
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

/**
 * Why a typed fast-model call has no answer: no backend, the data policy withholds the prompt, the
 * call failed, or the model answered something the schema does not accept.
 */
export type FastModelMiss = 'unconfigured' | 'withheld' | 'failed' | 'unreadable';

type FastModelAnswer<T> =
  | { ok: true; value: T; modelId: string }
  | { ok: false; miss: FastModelMiss; detail: string };

/**
 * One completion whose answer must parse against `schema` through the AI SDK's structured output.
 * `modelId` is the model the endpoint says answered, which pins an alias to the version behind it.
 * The prompt still states the answer's shape: an OpenAI-compatible proxy may only honour JSON mode.
 */
export async function callFastModelObject<T>(
  scope: EgressScope,
  prompt: string,
  schema: z.ZodType<T>,
  opts: { maxTokens: number; model?: string },
): Promise<FastModelAnswer<T>> {
  if (!env.LITELLM_API_URL)
    return { ok: false, miss: 'unconfigured', detail: 'LITELLM_API_URL is not set' };
  const sent = await egressScoped(scope, prompt);
  if (!sent.ok) return { ok: false, miss: 'withheld', detail: sent.refusal.code };
  const model = opts.model ?? fastModelName();
  let reasoningEffort: string | undefined = env.LITELLM_FAST_REASONING_EFFORT;
  for (let attempt = 0; ; attempt++) {
    try {
      const out = await generateText({
        model: fastModelSdk().chatModel(model),
        prompt: sent.text,
        output: Output.object({ schema }),
        ...callSettings(opts.maxTokens, reasoningEffort),
      });
      return { ok: true, value: out.output as T, modelId: out.response.modelId || model };
    } catch (err) {
      if (NoObjectGeneratedError.isInstance(err) || NoOutputGeneratedError.isInstance(err)) {
        return { ok: false, miss: 'unreadable', detail: err.message.slice(0, 200) };
      }
      const body = badRequestBody(err);
      if (
        attempt === 0 &&
        reasoningEffort &&
        body !== null &&
        REJECTS_REASONING_EFFORT.test(body)
      ) {
        reasoningEffort = undefined;
        continue;
      }
      return { ok: false, miss: 'failed', detail: errorText(err, 'llm.fast-model') };
    }
  }
}

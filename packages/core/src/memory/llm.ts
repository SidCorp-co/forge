import { env } from '../config/env.js';
import { logger } from '../logger.js';

/**
 * Minimal non-streaming completion against the LITELLM_* endpoint (any
 * OpenAI-compatible /chat/completions). Used by the memory-v2 background
 * intelligence (extraction, consolidation) — deliberately NOT the per-project
 * chat-provider stack: these are system jobs with a global model config and
 * must not depend on per-project chat settings.
 *
 * Returns null when the endpoint is unconfigured or the call fails — callers
 * treat null as "feature off / skip this run".
 */
export async function callFastModel(prompt: string, maxTokens: number): Promise<string | null> {
  if (!env.LITELLM_API_URL) return null;
  let response: Response;
  try {
    response = await fetch(`${env.LITELLM_API_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(env.LITELLM_API_KEY ? { Authorization: `Bearer ${env.LITELLM_API_KEY}` } : {}),
      },
      body: JSON.stringify({
        model: env.LITELLM_MODEL,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: maxTokens,
        temperature: 0,
      }),
    });
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'memory.llm: completion request failed');
    return null;
  }
  if (!response.ok) {
    logger.warn({ status: response.status }, 'memory.llm: completion call failed');
    return null;
  }
  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  return data.choices?.[0]?.message?.content?.trim() || null;
}

/** True when the fast-model endpoint is configured. */
export function fastModelConfigured(): boolean {
  return Boolean(env.LITELLM_API_URL);
}

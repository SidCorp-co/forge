/**
 * Minimal non-streaming completion for the system-job "fast model" — memory-v2
 * background intelligence (extraction, consolidation) and agent-session
 * auto-titling.
 *
 * Two backends, tried in the same priority order the chat-provider bootstrap
 * uses (`chat/providers/bootstrap.ts`): LITELLM_* (any OpenAI-compatible
 * /chat/completions), then GEMINI_API_KEY. Both are read from GLOBAL env, so
 * this stays deliberately independent of the per-project chat-provider stack
 * — these are system jobs with a global model config and must not depend on
 * per-project chat settings.
 *
 * Returns null when no backend is configured or the call fails — callers
 * treat null as "feature off / skip this run".
 */

import { env } from '../config/env.js';
import { logger } from '../logger.js';

/** Hard cap so a hung endpoint can never wedge a pg-boss worker. */
const COMPLETION_TIMEOUT_MS = 60_000;

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

async function callLiteLlm(prompt: string, maxTokens: number): Promise<string | null> {
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
      signal: AbortSignal.timeout(COMPLETION_TIMEOUT_MS),
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

// cm:why plain fetch against generateContent rather than reusing chat/providers/gemini.ts — that adapter is streaming-only (generateContentStream) and returns a ChatProvider bound to the per-project stack this module must stay out of
async function callGemini(prompt: string, maxTokens: number): Promise<string | null> {
  let response: Response;
  try {
    response = await fetch(
      `${GEMINI_API_BASE}/${encodeURIComponent(env.GEMINI_MODEL)}:generateContent`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': env.GEMINI_API_KEY as string,
        },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { maxOutputTokens: maxTokens, temperature: 0 },
        }),
        signal: AbortSignal.timeout(COMPLETION_TIMEOUT_MS),
      },
    );
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'memory.llm: gemini request failed');
    return null;
  }
  if (!response.ok) {
    logger.warn({ status: response.status }, 'memory.llm: gemini call failed');
    return null;
  }
  const data = (await response.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  const text = data.candidates?.[0]?.content?.parts
    ?.map((p) => p.text ?? '')
    .join('')
    .trim();
  return text || null;
}

// cm:guard keep this in sync with fastModelConfigured() — a backend callable here but not reported there makes every caller's `if (!fastModelConfigured()) skip` gate lie, which is how auto-title and memory-v2 went silently dead on forge-beta (ISS-726)
export async function callFastModel(prompt: string, maxTokens: number): Promise<string | null> {
  if (env.LITELLM_API_URL) return callLiteLlm(prompt, maxTokens);
  if (env.GEMINI_API_KEY) return callGemini(prompt, maxTokens);
  return null;
}

/** True when ANY fast-model backend is configured. */
export function fastModelConfigured(): boolean {
  return Boolean(env.LITELLM_API_URL || env.GEMINI_API_KEY);
}

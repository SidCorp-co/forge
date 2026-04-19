/**
 * Query Condenser — rewrites follow-up messages into standalone questions.
 * Uses LLM to decide whether condensation is needed (no regex heuristics).
 * Single responsibility: condense only, no intent classification.
 */

export interface CondensedQuery {
  standaloneQuestion: string;
  wasCondensed: boolean;
}

interface ConversationTurn {
  role: 'user' | 'assistant';
  content: string;
}

const CONDENSE_PROMPT = `Given this conversation, decide if the latest message needs rewriting to be understood without context.

If the message is ALREADY self-contained (greetings, complete questions, create commands with full details, etc.), output it unchanged.
If the message references something from the conversation (pronouns, short follow-ups, "that one", topic continuations), rewrite it as a standalone question.

Rules:
- Resolve pronouns and references using conversation history
- Preserve the original language (English, Vietnamese, or mixed)
- Keep the rewritten message concise
- NEVER remove key nouns, subjects, or filters from the original message. The rewritten version must contain at least as much information as the original.
- If the original message already contains specific topics (e.g. "dashboard", "pending"), keep them in the output
- Output ONLY the final message, nothing else

Recent conversation:
{history}

Latest message: "{message}"

Output:`;

// LRU cache
const cache = new Map<string, CondensedQuery>();
const MAX_CACHE = 200;
const CONTEXT_TURNS = 6;

function buildHistorySummary(history: ConversationTurn[]): string {
  return history.slice(-CONTEXT_TURNS)
    .map((t) => `${t.role === 'user' ? 'User' : 'Assistant'}: ${t.content.slice(0, 150)}`)
    .join('\n');
}

function cacheKey(message: string, historyKey: string): string {
  return `${historyKey}||${message.toLowerCase().trim().replace(/\s+/g, ' ')}`;
}

/**
 * Condense a follow-up message into a standalone question using LLM.
 * The LLM decides whether rewriting is needed — no regex heuristics.
 * Returns original unchanged when: no history, or LLM returns same text.
 */
export async function condenseQuery(
  strapi: any,
  message: string,
  history: ConversationTurn[],
): Promise<CondensedQuery> {
  // No history → nothing to condense
  if (!history || history.length === 0) {
    return { standaloneQuestion: message, wasCondensed: false };
  }

  const historySummary = buildHistorySummary(history);
  const key = cacheKey(message, historySummary.slice(0, 200));

  const cached = cache.get(key);
  if (cached) return cached;

  try {
    const apiUrl = process.env.LITELLM_API_URL;
    const apiKey = process.env.LITELLM_API_KEY;
    if (!apiUrl) return { standaloneQuestion: message, wasCondensed: false };

    const prompt = CONDENSE_PROMPT
      .replace('{history}', historySummary)
      .replace('{message}', message.slice(0, 200));

    const response = await fetch(`${apiUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey && { Authorization: `Bearer ${apiKey}` }),
      },
      body: JSON.stringify({
        model: process.env.LITELLM_FAST_MODEL || process.env.LITELLM_MODEL || 'gemini-flash',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 120,
        temperature: 0,
      }),
    });

    if (!response.ok) {
      strapi.log.warn(`[query-condenser] LLM call failed: ${response.status}`);
      return { standaloneQuestion: message, wasCondensed: false };
    }

    const data = (await response.json()) as any;
    const raw = (data.choices?.[0]?.message?.content || '').trim();

    // Safety: if condensed output lost too much content, use original
    const tooShort = raw.length < message.length * 0.5 && message.length > 15;
    const standaloneQuestion = raw && raw.length > 3 && !tooShort ? raw : message;
    const wasCondensed = standaloneQuestion.toLowerCase().trim() !== message.toLowerCase().trim();

    const result: CondensedQuery = { standaloneQuestion, wasCondensed };

    if (cache.size >= MAX_CACHE) {
      const first = cache.keys().next().value;
      if (first !== undefined) cache.delete(first);
    }
    cache.set(key, result);

    if (wasCondensed) {
      strapi.log.info(`[query-condenser] "${message.slice(0, 60)}" → "${standaloneQuestion.slice(0, 60)}"`);
    }
    return result;
  } catch (err: any) {
    strapi.log.warn(`[query-condenser] Condensation failed: ${err.message}`);
    return { standaloneQuestion: message, wasCondensed: false };
  }
}

/**
 * RAG Gate — single LLM call that replaces condenseQuery + classifyIntent.
 * Outputs intent classification AND standalone query in one pass.
 */

export type QueryIntent = 'SEARCH' | 'LOOKUP' | 'CREATE' | 'SUMMARY' | 'CHAT' | 'ACTION';

export interface RagGateResult {
  intent: QueryIntent;
  standaloneQuery: string;
  wasCondensed: boolean;
  searchQueryEn?: string;
}

interface ConversationTurn {
  role: 'user' | 'assistant';
  content: string;
}

const RAG_GATE_PROMPT = `You are a chat router. Given the user's latest message and recent conversation, output a JSON object with two fields:

1. "intent" — classify into exactly one:
   - LOOKUP: asking for a filtered list using structured fields like status, priority, category, date, or type (e.g. "show open items", "high priority bugs", "issues created this week")
   - SEARCH: looking for specific information by content, asking about a topic by name/keyword, or asking about the status/progress of a specific named item (e.g. "how is the login fix going", "issues about payment", "xác nhận công tháng này")
   - CREATE: wants to create, add, submit, or log a new record or request
   - SUMMARY: asking about overall status, overview, statistics, progress, metrics, or health
   - ACTION: giving a direct instruction, answering the assistant's question, making a selection, confirming an action, or issuing a command (e.g. "deploy it", "yes", "approve", "the second one", "both", "do it"). Short imperative messages are almost always ACTION, not CHAT.
   - CHAT: greeting, thanks, or off-topic small talk (NOT short commands)

2. "query" — if the message references prior conversation (pronouns, short follow-ups, "that one"), rewrite it as a standalone question. If already self-contained, output the original message unchanged. Preserve the original language. Never drop key nouns or filters.

3. "searchEn" — translate the query to English for technical search. Use domain terms (e.g. "candidates", "campaigns", "revenue", "statistics", "overview"). Keep it concise (under 15 words). If already English, copy the query.

{context}{examples}Output ONLY a single-line compact JSON object (no markdown, no code fences, no newlines): {"intent":"...","query":"...","searchEn":"..."}

Message: "{message}"`;

const CONTEXT_TURNS = 4;

// LRU cache
const cache = new Map<string, RagGateResult>();
const MAX_CACHE = 200;

function buildContext(history: ConversationTurn[]): string {
  if (!history || history.length === 0) return '';
  const recent = history.slice(-CONTEXT_TURNS);
  const lines = recent
    .map((t) => `${t.role === 'user' ? 'User' : 'Assistant'}: ${t.content.slice(0, 150)}`)
    .join('\n');
  return `Recent conversation:\n${lines}\n\n`;
}

function cacheKey(message: string, contextStr: string, intentExamples?: string[]): string {
  // Include a fingerprint of intentExamples so different projects don't share cached results
  const exFp = intentExamples?.length ? `ex:${intentExamples.length}:${intentExamples[0].slice(0, 30)}` : '';
  return `${exFp}||${contextStr.slice(0, 200)}||${message.toLowerCase().trim().replace(/\s+/g, ' ')}`;
}

/**
 * Single LLM call that classifies intent and condenses query.
 * Replaces the previous 2-call pipeline (condenseQuery + classifyIntent).
 */
export async function ragGate(
  strapi: any,
  message: string,
  history: ConversationTurn[],
  intentExamples?: string[],
): Promise<RagGateResult> {
  const contextStr = buildContext(history);
  const key = cacheKey(message, contextStr, intentExamples);

  const cached = cache.get(key);
  if (cached) return cached;

  const fallback: RagGateResult = { intent: 'SEARCH', standaloneQuery: message, wasCondensed: false };

  try {
    const apiUrl = process.env.LITELLM_API_URL;
    const apiKey = process.env.LITELLM_API_KEY;
    if (!apiUrl) return fallback;

    // Build examples section: use project-specific intentExamples if available
    const examplesSection = intentExamples?.length
      ? `Examples:\n${intentExamples.join('\n')}\n\n`
      : '';

    const prompt = RAG_GATE_PROMPT
      .replace('{context}', contextStr)
      .replace('{examples}', examplesSection)
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
        max_tokens: 200,
        temperature: 0,
      }),
    });

    if (!response.ok) {
      strapi.log.warn(`[rag-gate] LLM call failed: ${response.status}`);
      return fallback;
    }

    const data = (await response.json()) as any;
    const raw = (data.choices?.[0]?.message?.content || '').trim();

    // Parse JSON response
    let intent: QueryIntent = 'SEARCH';
    let standaloneQuery = message;
    let searchQueryEn: string | undefined;

    try {
      // Extract JSON from response (handle markdown code blocks)
      const jsonStr = raw.replace(/^```json?\s*/, '').replace(/\s*```$/, '');
      const parsed = JSON.parse(jsonStr);

      const upper = (parsed.intent || '').toUpperCase();
      intent = (['ACTION', 'LOOKUP', 'SEARCH', 'CREATE', 'SUMMARY', 'CHAT'] as const)
        .find((i) => upper.includes(i)) || 'SEARCH';

      if (parsed.query && typeof parsed.query === 'string' && parsed.query.length > 3) {
        // Safety: if condensed output lost too much content, use original
        const tooShort = parsed.query.length < message.length * 0.5 && message.length > 15;
        if (!tooShort) standaloneQuery = parsed.query;
      }
      if (parsed.searchEn && typeof parsed.searchEn === 'string' && parsed.searchEn.length > 3) {
        searchQueryEn = parsed.searchEn;
      }
    } catch {
      // Fallback: try to extract intent from raw text
      const upper = raw.toUpperCase();
      intent = (['ACTION', 'LOOKUP', 'SEARCH', 'CREATE', 'SUMMARY', 'CHAT'] as const)
        .find((i) => upper.includes(i)) || 'SEARCH';
    }

    const wasCondensed = standaloneQuery.toLowerCase().trim() !== message.toLowerCase().trim();

    const result: RagGateResult = { intent, standaloneQuery, wasCondensed, searchQueryEn };

    // Update cache (evict oldest if full)
    if (cache.size >= MAX_CACHE) {
      const first = cache.keys().next().value;
      if (first !== undefined) cache.delete(first);
    }
    cache.set(key, result);

    strapi.log.info(`[rag-gate] intent=${intent} condensed=${wasCondensed} query="${message.slice(0, 60)}"${wasCondensed ? ` → "${standaloneQuery.slice(0, 60)}"` : ''}`);

    return result;
  } catch (err: any) {
    strapi.log.warn(`[rag-gate] Failed: ${err.message}`);
    return fallback;
  }
}

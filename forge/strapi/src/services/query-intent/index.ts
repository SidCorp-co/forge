export type QueryIntent = 'SEARCH' | 'CREATE' | 'SUMMARY' | 'CHAT' | 'LOOKUP' | 'ACTION';

export interface IntentResult {
  intent: QueryIntent;
  rewrittenQuery: string; // passthrough — kept for backward compat
}

const INTENT_PROMPT = `Classify this chat message into exactly one intent:
- LOOKUP: asking for a filtered list of issues by status, priority, category, or type (e.g. "show critical bugs", "open features", "high priority issues")
- SEARCH: looking for specific information, asking about a topic, debugging, or exploring issues by keyword
- CREATE: wants to create/add a new issue, bug report, or feature request
- SUMMARY: asking about project status, overview, statistics, progress, or health
- ACTION: giving a direct instruction, answering the assistant's question, making a selection, confirming an action, or issuing a command (e.g. "deploy it", "yes", "strapi and web", "the second one", "approve it", "both", "do it")
- CHAT: greeting, thanks, or off-topic small talk

{context}Examples:
"any pagination issues?" → SEARCH
"what are the critical priority issues?" → LOOKUP
"show me all open bugs" → LOOKUP
"list high priority features" → LOOKUP
"issues related to authentication" → SEARCH
"tạo issue cho login page" → CREATE
"project status?" → SUMMARY
"hello" → CHAT
"how many bugs are open?" → SUMMARY
"what's the status of ISS-42?" → SEARCH
"are there duplicate issues?" → SEARCH
"thêm bug mới cho trang đăng nhập" → CREATE
"thêm bug cho trang xuất dữ liệu" → CREATE
"thanks!" → CHAT
"show me critical blockers" → LOOKUP
"hiện tất cả issue đang mở" → LOOKUP
"báo cáo nghỉ phép" → SEARCH
"vấn đề chấm công" → SEARCH
"lỗi trang đăng nhập" → SEARCH
"yes" → ACTION
"deploy both" → ACTION
"strapi and web" → ACTION
"the first one" → ACTION
"approve" → ACTION
"do it" → ACTION

Message: "{message}"
Intent:`;

// Simple LRU cache — key includes context hint for accurate caching
const cache = new Map<string, IntentResult>();
const MAX_CACHE = 100;

function normalizeKey(message: string, contextHint: string): string {
  return `${contextHint}||${message.toLowerCase().trim().replace(/\s+/g, ' ')}`;
}

interface ConversationTurn {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * Build a short context hint from conversation history so the classifier
 * understands whether the user is responding to a question or starting fresh.
 */
function buildContextHint(history?: ConversationTurn[]): string {
  if (!history || history.length === 0) return '';

  // Find the last assistant text message
  const lastAssistant = [...history].reverse().find((t) => t.role === 'assistant');
  if (!lastAssistant?.content) return '';

  const text = lastAssistant.content.trim();
  if (!text) return '';

  return `The assistant's last message was: "${text.slice(0, 150)}"\n\n`;
}

/**
 * Classify a chat message into an intent using a fast LLM call.
 * Optionally accepts conversation history to detect follow-up responses.
 * Falls back to SEARCH on any error.
 */
export async function classifyIntent(
  strapi: any,
  message: string,
  history?: ConversationTurn[],
): Promise<IntentResult> {
  const contextHint = buildContextHint(history);
  const key = normalizeKey(message, contextHint.slice(0, 80));

  // Check cache
  const cached = cache.get(key);
  if (cached) return cached;

  try {
    const apiUrl = process.env.LITELLM_API_URL;
    const apiKey = process.env.LITELLM_API_KEY;
    if (!apiUrl) return { intent: 'SEARCH', rewrittenQuery: message };

    const prompt = INTENT_PROMPT
      .replace('{context}', contextHint)
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
        max_tokens: 10,
        temperature: 0,
      }),
    });

    if (!response.ok) {
      strapi.log.warn(`[query-intent] LLM call failed: ${response.status}`);
      return { intent: 'SEARCH', rewrittenQuery: message };
    }

    const data = (await response.json()) as any;
    const raw = (data.choices?.[0]?.message?.content || '').trim();

    const upper = raw.toUpperCase();
    const intent: QueryIntent = (['ACTION', 'LOOKUP', 'SEARCH', 'CREATE', 'SUMMARY', 'CHAT'] as const)
      .find((i) => upper.includes(i)) || 'SEARCH';

    const result: IntentResult = { intent, rewrittenQuery: message };

    // Update cache (evict oldest if full)
    if (cache.size >= MAX_CACHE) {
      const first = cache.keys().next().value;
      if (first !== undefined) cache.delete(first);
    }
    cache.set(key, result);

    return result;
  } catch (err: any) {
    strapi.log.warn(`[query-intent] Classification failed: ${err.message}`);
    return { intent: 'SEARCH', rewrittenQuery: message };
  }
}

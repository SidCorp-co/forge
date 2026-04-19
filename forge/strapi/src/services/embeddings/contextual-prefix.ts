/**
 * LLM-based contextual prefix generation (Anthropic Contextual Retrieval pattern).
 * Generates a 1-2 sentence context per chunk describing what it covers within the full document.
 * Uses the fast model (gemini-flash) to minimize cost.
 */

const FAST_MODEL = () => process.env.LITELLM_FAST_MODEL || process.env.LITELLM_MODEL || 'gemini-flash';

function getLog(): Record<string, (...args: any[]) => void> {
  const log = (globalThis as any).strapi?.log;
  if (!log) return { info: console.log, warn: console.warn, error: console.error, debug: () => {} };
  return {
    info: log.info.bind(log),
    warn: log.warn.bind(log),
    error: log.error.bind(log),
    debug: log.debug.bind(log),
  };
}

export function isContextualEnabled(): boolean {
  return process.env.CONTEXTUAL_EMBEDDING_ENABLED !== 'false';
}

function buildPrompt(fullDocument: string, chunks: string[], sourceType: string): string {
  const docPreview = fullDocument.length > 4000 ? fullDocument.slice(0, 4000) + '...' : fullDocument;

  if (chunks.length === 1) {
    return `<document>
${docPreview}
</document>

Here is a chunk from that document:
<chunk>
${chunks[0].slice(0, 2000)}
</chunk>

Give a short 1-2 sentence context (under 200 chars) explaining what this ${sourceType} chunk covers. Be specific and factual. Output ONLY the context text, nothing else.`;
  }

  const chunksFormatted = chunks
    .map((c, i) => `<chunk index="${i}">\n${c.slice(0, 1500)}\n</chunk>`)
    .join('\n');

  return `<document>
${docPreview}
</document>

Here are ${chunks.length} chunks from that document:
${chunksFormatted}

For each chunk, give a short 1-2 sentence context (under 200 chars each) explaining what that ${sourceType} chunk covers within the document. Be specific and factual.

Output a JSON array of strings, one per chunk, in order. Example: ["Context for chunk 0", "Context for chunk 1"]
Output ONLY the JSON array, nothing else.`;
}

/**
 * Generate contextual prefixes for chunks using LLM.
 * Returns array of prefix strings (one per chunk), or empty array on failure.
 */
export async function generateContextualPrefixes(
  fullDocument: string,
  chunks: string[],
  sourceType: string,
): Promise<string[]> {
  const log = getLog();

  if (!isContextualEnabled()) return [];
  if (chunks.length === 0) return [];

  const apiUrl = process.env.LITELLM_API_URL;
  const apiKey = process.env.LITELLM_API_KEY;
  if (!apiUrl) return [];

  const prompt = buildPrompt(fullDocument, chunks, sourceType);

  try {
    const response = await fetch(`${apiUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey && { Authorization: `Bearer ${apiKey}` }),
      },
      body: JSON.stringify({
        model: FAST_MODEL(),
        messages: [{ role: 'user', content: prompt }],
        max_tokens: chunks.length === 1 ? 100 : chunks.length * 120,
        temperature: 0,
      }),
    });

    if (!response.ok) {
      log.warn(`[contextual-prefix] LLM call failed: ${response.status}`);
      return [];
    }

    const data = (await response.json()) as any;
    const raw = (data.choices?.[0]?.message?.content || '').trim();

    // Log token usage for cost tracking
    const usage = data.usage;
    if (usage) {
      log.debug(
        `[contextual-prefix] ${sourceType}: ${usage.prompt_tokens}in/${usage.completion_tokens}out tokens, ${chunks.length} chunks`,
      );
    }

    if (!raw) return [];

    // Single chunk: raw text is the prefix
    if (chunks.length === 1) {
      const prefix = raw.replace(/^["']|["']$/g, '').trim();
      return prefix ? [prefix] : [];
    }

    // Multiple chunks: parse JSON array
    const jsonStr = raw.replace(/^```json?\s*/, '').replace(/\s*```$/, '');
    const parsed = JSON.parse(jsonStr);

    if (!Array.isArray(parsed) || parsed.length !== chunks.length) {
      log.warn(`[contextual-prefix] Expected ${chunks.length} prefixes, got ${Array.isArray(parsed) ? parsed.length : 'non-array'}`);
      return [];
    }

    return parsed.map((p: any) => (typeof p === 'string' ? p.trim() : ''));
  } catch (err: any) {
    log.warn(`[contextual-prefix] generation failed: ${err.message}`);
    return [];
  }
}

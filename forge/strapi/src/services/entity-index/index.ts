import { getQdrantClient } from '../embeddings/qdrant';
import type { SearchResult } from '../embeddings';

const COLLECTION_NAME = 'forge_embeddings';
const FAST_MODEL = process.env.LITELLM_FAST_MODEL || 'gemini/gemini-2.0-flash';

export type { EntityType, ExtractedEntity as TypedEntity } from '../knowledge-graph/entity-extractor';

const ENTITY_PROMPT = `Extract 5-10 searchable keywords/entities from this text. Include:
- Feature names (e.g. "pagination", "authentication", "dark-mode")
- Component names (e.g. "sidebar", "login-page", "dashboard")
- Technical terms (e.g. "websocket", "caching", "api-endpoint")
- Domain concepts not literally in the text (e.g. "token expired" → "session-management")

Return ONLY a JSON array of lowercase strings. No explanation.

Text: "{text}"`;


// Common English stopwords to filter out
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'from', 'is', 'it', 'this', 'that', 'are', 'was',
  'be', 'has', 'had', 'have', 'will', 'can', 'do', 'does', 'did', 'not',
  'no', 'so', 'if', 'its', 'any', 'all', 'new', 'one', 'two', 'may',
  'also', 'than', 'more', 'some', 'what', 'when', 'who', 'how', 'which',
  'about', 'into', 'been', 'would', 'could', 'should', 'just', 'there',
  'then', 'now', 'each', 'only', 'very', 'other', 'our', 'your', 'their',
]);

/**
 * Extract searchable entities from text using heuristics (no LLM).
 * Extracts: camelCase/PascalCase splits, path segments, hyphenated terms, significant words.
 */
export function extractEntities(text: string): string[] {
  const entities = new Set<string>();

  // Split camelCase/PascalCase into parts: "loginPage" → ["login", "page"]
  const camelSplits = text.match(/[A-Z]?[a-z]+|[A-Z]+(?=[A-Z][a-z]|\d|\b)/g) || [];
  for (const part of camelSplits) {
    const lower = part.toLowerCase();
    if (lower.length >= 3 && !STOPWORDS.has(lower)) {
      entities.add(lower);
    }
  }

  // Extract path segments: "src/api/users" → ["src", "api", "users"]
  const pathSegments = text.match(/[\w-]+(?=\/)/g) || [];
  for (const seg of pathSegments) {
    const lower = seg.toLowerCase();
    if (lower.length >= 3 && !STOPWORDS.has(lower)) {
      entities.add(lower);
    }
  }

  // Extract hyphenated terms as both whole and parts: "user-auth" → ["user-auth", "user", "auth"]
  const hyphenated = text.match(/\b[\w]+-[\w]+(?:-[\w]+)*/g) || [];
  for (const term of hyphenated) {
    const lower = term.toLowerCase();
    entities.add(lower);
    for (const part of lower.split('-')) {
      if (part.length >= 3 && !STOPWORDS.has(part)) {
        entities.add(part);
      }
    }
  }

  // Regular words ≥3 chars, not stopwords
  const words = text.split(/[\s\n\r\t,.;:!?()\[\]{}"'`]+/);
  for (const word of words) {
    const lower = word.toLowerCase().replace(/[^a-z0-9-]/g, '');
    if (lower.length >= 3 && !STOPWORDS.has(lower)) {
      entities.add(lower);
    }
  }

  return Array.from(entities);
}

/**
 * Extract entities using a fast LLM for semantic understanding.
 * Returns additional entities beyond what heuristics can find.
 */
export async function extractEntitiesLLM(text: string): Promise<string[]> {
  const apiUrl = process.env.LITELLM_API_URL;
  const apiKey = process.env.LITELLM_API_KEY;
  if (!apiUrl || !apiKey) return [];

  // Truncate to avoid large payloads
  const truncated = text.slice(0, 1500);

  try {
    const response = await fetch(`${apiUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: FAST_MODEL,
        messages: [{ role: 'user', content: ENTITY_PROMPT.replace('{text}', truncated) }],
        max_tokens: 200,
        temperature: 0,
      }),
    });

    if (!response.ok) return [];

    const data = (await response.json()) as any;
    const content = data.choices?.[0]?.message?.content?.trim() || '';

    // Parse JSON array from response (handle markdown code blocks)
    const jsonStr = content.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
    const parsed = JSON.parse(jsonStr);
    if (!Array.isArray(parsed)) return [];

    return parsed
      .filter((e: any) => typeof e === 'string' && e.length >= 2)
      .map((e: string) => e.toLowerCase().trim())
      .slice(0, 15);
  } catch {
    return [];
  }
}

/**
 * Enrich existing Qdrant points with LLM-extracted entities.
 * Merges LLM entities with existing heuristic entities.
 */
export async function enrichEntitiesWithLLM(
  projectId: string,
  sourceType: string,
  sourceId: string,
  text: string,
): Promise<void> {
  const qdrant = getQdrantClient();
  if (!qdrant) return;

  const llmEntities = await extractEntitiesLLM(text);
  if (llmEntities.length === 0) return;

  // Fetch existing points to merge entities
  const existing = await qdrant.scroll(COLLECTION_NAME, {
    filter: {
      must: [
        { key: 'project_id', match: { value: projectId } },
        { key: 'source_type', match: { value: sourceType } },
        { key: 'source_id', match: { value: sourceId } },
      ],
    },
    limit: 20,
    with_payload: true,
    with_vector: false,
  });

  if (!existing.points?.length) return;

  const points = existing.points.map((point) => {
    const currentEntities: string[] = (point.payload as any)?.entities || [];
    const merged = Array.from(new Set([...currentEntities, ...llmEntities]));
    return {
      id: point.id,
      payload: { ...point.payload, entities: merged },
    };
  });

  // Use set_payload to update without re-embedding
  for (const point of points) {
    await qdrant.setPayload(COLLECTION_NAME, {
      points: [point.id],
      payload: { entities: point.payload.entities },
    });
  }
}

/**
 * Search Qdrant for entries matching any of the given entity keywords.
 * Uses Qdrant's payload `match` filter on the `entities` field.
 * Score is proportional to keyword overlap (more matches = higher score).
 */
export async function searchByEntities(
  projectId: string,
  keywords: string[],
): Promise<SearchResult[]> {
  const qdrant = getQdrantClient();
  if (!qdrant || keywords.length === 0) return [];

  const results = await qdrant.scroll(COLLECTION_NAME, {
    filter: {
      must: [
        { key: 'project_id', match: { value: projectId } },
        { key: 'entities', match: { any: keywords } },
      ],
    },
    limit: 30,
    with_payload: true,
    with_vector: false,
  });

  const keywordSet = new Set(keywords);

  return (results.points || []).map((point) => {
    const entities: string[] = (point.payload as any)?.entities || [];
    const overlap = entities.filter((e) => keywordSet.has(e)).length;
    // Score: 0.50 base + up to 0.40 for overlap ratio (max ~0.90)
    const score = 0.50 + Math.min(0.40, (overlap / keywordSet.size) * 0.40);
    return {
      score,
      payload: point.payload as SearchResult['payload'],
    };
  }).sort((a, b) => b.score - a.score).slice(0, 15);
}

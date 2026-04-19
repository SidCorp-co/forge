import crypto from 'crypto';
import pLimit from 'p-limit';
import { getQdrantClient } from './qdrant';
import { chunkText } from './chunker';
import { extractEntities } from '../entity-index';
import { generateContextualPrefixes } from './contextual-prefix';
import { buildDocSparseVector, buildQuerySparseVector, buildMetadataText, tokenize } from './bm25';

const COLLECTION_NAME = 'forge_embeddings';

export interface SearchResult {
  score: number;
  payload: {
    source_type: string;
    source_id: string;
    text: string;
    metadata: Record<string, any>;
    project_id: string;
    chunk_index: number;
  };
}

const embedLimit = pLimit(5);

export function sanitizeContent(text: string): string {
  return text
    .replace(/<img[^>]*>/gi, '') // strip img tags (may contain large base64 data)
    .replace(/<[^>]{0,500}>/g, '') // strip remaining HTML tags
    .replace(/\s{2,}/g, ' ') // collapse whitespace
    .trim();
}

export async function embed(texts: string[]): Promise<number[][]> {
  const apiUrl = process.env.LITELLM_API_URL;
  const apiKey = process.env.LITELLM_API_KEY;
  const model = process.env.LITELLM_EMBEDDING_MODEL || 'text-embedding-3-small';

  if (!apiUrl) {
    throw new Error('[embeddings] LITELLM_API_URL not set');
  }

  let response: Response;
  try {
    response = await fetch(`${apiUrl}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey && { Authorization: `Bearer ${apiKey}` }),
      },
      body: JSON.stringify({
        model,
        input: texts,
        ...(process.env.LITELLM_EMBEDDING_DIMENSIONS && {
          dimensions: parseInt(process.env.LITELLM_EMBEDDING_DIMENSIONS, 10),
        }),
      }),
    });
  } catch (err: any) {
    throw new Error(`[embeddings] Failed to connect to embedding service at ${apiUrl}: ${err.message}`);
  }

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`[embeddings] Embedding request failed: ${response.status} ${body}`);
  }

  const data = (await response.json()) as { data: Array<{ embedding: number[] }> };
  return data.data.map((d) => d.embedding);
}

function sha1ToUuid(source: string): string {
  const hash = crypto.createHash('sha1').update(source).digest('hex');
  const h = hash.substring(0, 32);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/**
 * Build a contextual prefix for embedding enrichment (Anthropic Contextual Retrieval pattern).
 * Prepended to chunks for embedding vector only — stored text stays original.
 */
function buildContextPrefix(source_type: string, metadata: Record<string, any>): string {
  switch (source_type) {
    case 'issue': {
      const parts = [`This is from issue '${metadata.title || 'Untitled'}'`];
      const tags = [metadata.status, metadata.priority].filter(Boolean);
      if (tags.length) parts[0] += ` [${tags.join(', ')}]`;
      if (metadata.projectName) parts[0] += ` in project ${metadata.projectName}`;
      parts[0] += '.';
      return parts[0];
    }
    case 'comment':
      return `This is a comment on issue '${metadata.issueTitle || 'Unknown'}'.`;
    case 'skill':
      return `This is a project skill/guideline called '${metadata.name || 'Untitled'}'.`;
    case 'chat_session':
      return `This is a summary of a past chat session titled '${metadata.title || 'Untitled'}'.`;
    case 'memory':
      return `This is a remembered ${metadata.category || 'fact'} (${metadata.scope || 'user'} scope).`;
    case 'mcp_schema': {
      const section = metadata.section ? ` — ${metadata.section} section` : '';
      return `This is a GraphQL schema reference for MCP server '${metadata.serverKey || 'unknown'}'${section}. Use these queries and types when constructing GraphQL calls.`;
    }
    case 'pikachu_decision':
      return `Pipeline decision (${metadata.decisionType || 'routing'}): ${metadata.action} ${metadata.skill || ''} for ${metadata.fromStatus}→${metadata.toStatus}. Outcome: ${metadata.outcome || 'pending'}.`;
    case 'ci_pattern':
      return `CI failure pattern: ${metadata.failureType || 'unknown'}. Files: ${metadata.filePattern || 'any'}.`;
    case 'session_context': {
      const fieldDesc: Record<string, string> = { decisions: 'architectural decisions', filesModified: 'modified files', errorsResolved: 'resolved errors', reviewFeedback: 'review feedback' };
      return `This is ${fieldDesc[metadata.fieldName] || metadata.fieldName} from issue '${metadata.issueTitle || 'Unknown'}' (ISS-${metadata.issueId || '?'}).`;
    }
    default:
      return '';
  }
}

export async function upsertEmbedding({
  project_id,
  source_type,
  source_id,
  text,
  metadata = {},
  contextual = false,
}: {
  project_id: string;
  source_type: string;
  source_id: string;
  text: string;
  metadata?: Record<string, any>;
  contextual?: boolean;
}): Promise<void> {
  const qdrant = getQdrantClient();
  if (!qdrant) return;

  const chunks = chunkText(text);

  // Contextual chunk enrichment: LLM-generated per-chunk prefix (Anthropic Contextual Retrieval)
  // Falls back to template-based prefix if LLM fails or contextual is disabled
  let contextualPrefixes: string[] = [];
  if (contextual) {
    contextualPrefixes = await generateContextualPrefixes(text, chunks, source_type);
  }

  const templatePrefix = buildContextPrefix(source_type, metadata);
  const enrichedChunks = chunks.map((chunk, i) => {
    const prefix = contextualPrefixes[i] || templatePrefix;
    return prefix ? `${prefix}\n\n${chunk}` : chunk;
  });

  const vectors = await embedLimit(() => embed(enrichedChunks));

  const allText = text; // full text for entity extraction
  const entities = extractEntities(allText);

  const metadataText = buildMetadataText(metadata);

  const points = chunks.map((chunk, i) => ({
    id: sha1ToUuid(`${project_id}:${source_type}:${source_id}:${i}`),
    vector: {
      dense: vectors[i],
      bm25: buildDocSparseVector(chunk, metadataText),
    },
    payload: {
      project_id,
      source_type,
      source_id,
      text: chunk,
      chunk_index: i,
      metadata,
      entities,
      ...(contextualPrefixes[i] && { contextual_prefix: contextualPrefixes[i] }),
    },
  }));

  await qdrant.upsert(COLLECTION_NAME, { points });
}

export interface MetadataFilter {
  key: string;
  match: { value?: string; any?: string[] };
}

export async function searchSimilar(
  projectId: string,
  query: string,
  topK = 20,
  sourceTypes?: string[],
  metadataFilters?: MetadataFilter[],
): Promise<SearchResult[]> {
  const qdrant = getQdrantClient();
  if (!qdrant) return [];

  const [queryVector] = await embedLimit(() => embed([query]));

  const must: Record<string, any>[] = [
    { key: 'project_id', match: { value: projectId } },
  ];
  if (sourceTypes?.length) {
    must.push({ key: 'source_type', match: { any: sourceTypes } });
  }
  if (metadataFilters?.length) {
    for (const f of metadataFilters) {
      must.push({ key: f.key, match: f.match });
    }
  }
  const filter = { must };

  const results = await qdrant.search(COLLECTION_NAME, {
    vector: { name: 'dense', vector: queryVector },
    limit: topK,
    filter,
    with_payload: true,
  });

  return results.map((r) => ({
    score: r.score,
    payload: r.payload as SearchResult['payload'],
  }));
}

export async function removeEmbeddings(sourceType: string, sourceId: string): Promise<void> {
  const qdrant = getQdrantClient();
  if (!qdrant) return;

  await qdrant.delete(COLLECTION_NAME, {
    filter: {
      must: [
        { key: 'source_type', match: { value: sourceType } },
        { key: 'source_id', match: { value: sourceId } },
      ],
    },
  });
}

/**
 * Remove all embeddings matching project + source_type + optional metadata.category.
 * Used to bulk-prune stale entries (e.g., tool_patterns after schema resync).
 */
export async function removeByFilter(
  projectId: string,
  sourceType: string,
  metadataCategory?: string,
): Promise<void> {
  const qdrant = getQdrantClient();
  if (!qdrant) return;

  const must: Record<string, any>[] = [
    { key: 'project_id', match: { value: projectId } },
    { key: 'source_type', match: { value: sourceType } },
  ];
  if (metadataCategory) {
    must.push({ key: 'metadata.category', match: { value: metadataCategory } });
  }

  await qdrant.delete(COLLECTION_NAME, { filter: { must } });
}

/**
 * BM25 keyword search — scores points client-side from stored text payloads.
 * Scrolls Qdrant for candidate points (filtered by entity keywords), then
 * computes BM25 scores locally. No sparse vector dependency.
 */
export async function searchBM25(
  projectId: string,
  query: string,
  topK = 20,
  sourceTypes?: string[],
  metadataFilters?: MetadataFilter[],
): Promise<SearchResult[]> {
  const qdrant = getQdrantClient();
  if (!qdrant) return [];

  const queryTokens = tokenize(query);
  if (queryTokens.size === 0) return [];

  const must: Record<string, any>[] = [
    { key: 'project_id', match: { any: [projectId, '__global__'] } },
  ];
  if (sourceTypes?.length) {
    must.push({ key: 'source_type', match: { any: sourceTypes } });
  }
  if (metadataFilters?.length) {
    for (const f of metadataFilters) {
      must.push({ key: f.key, match: f.match });
    }
  }
  const filter = { must };

  // Try Qdrant native sparse vector search first
  try {
    const sparseQuery = buildQuerySparseVector(query);
    const results = await qdrant.search(COLLECTION_NAME, {
      vector: { name: 'bm25', vector: sparseQuery },
      limit: topK,
      filter,
      with_payload: true,
    });
    if (results.length > 0) {
      return results.map((r) => ({
        score: r.score,
        payload: r.payload as SearchResult['payload'],
      }));
    }
  } catch {
    // Sparse search not available — fall back to client-side BM25 scoring
  }

  // Client-side BM25 fallback: scroll candidates filtered by entity keywords
  const { extractEntities } = await import('../entity-index');
  const keywords = extractEntities(query).slice(0, 15);
  const scrollMust = [...must];
  if (keywords.length > 0) {
    scrollMust.push({ key: 'entities', match: { any: keywords } });
  }

  const candidates = await qdrant.scroll(COLLECTION_NAME, {
    filter: { must: scrollMust },
    limit: Math.min(topK * 5, 200),
    with_payload: true,
    with_vector: false,
  });

  if (!candidates.points?.length) return [];

  const scored: SearchResult[] = [];
  for (const point of candidates.points) {
    const payload = point.payload as any;
    const text = payload?.text || '';
    const metaText = buildMetadataText(payload?.metadata || {});
    const docText = metaText ? `${text} ${metaText}` : text;

    const docTokens = tokenize(docText);
    const docLen = Array.from(docTokens.values()).reduce((s, v) => s + v, 0);

    let score = 0;
    for (const [qToken] of queryTokens) {
      const tf = docTokens.get(qToken) || 0;
      if (tf === 0) continue;
      const tfNorm = (tf * 2.2) / (tf + 1.2 * (0.25 + 0.75 * docLen / 150));
      score += tfNorm;
    }

    if (score > 0) {
      scored.push({
        score,
        payload: {
          source_type: payload.source_type || '',
          source_id: payload.source_id || '',
          text: payload.text || '',
          project_id: payload.project_id || projectId,
          chunk_index: payload.chunk_index || 0,
          metadata: payload.metadata || {},
        },
      });
    }
  }

  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

import type { SearchResult } from './index';

interface RankedResult extends SearchResult {
  finalScore: number;
}

/**
 * Heuristic reranker that boosts RAG results based on source type,
 * recency, status, keyword overlap, and other signals.
 */
export function rerank(
  results: SearchResult[],
  query: string,
  topK = 8,
  widgetUserId?: string,
  crossEncoderScores?: Map<string, number>,
): RankedResult[] {
  const queryWords = new Set(
    query.toLowerCase().split(/\s+/).filter((w) => w.length > 2),
  );
  const now = Date.now();
  const thirtyDays = 30 * 24 * 60 * 60 * 1000;

  // Normalise input scores to 0–1 range so heuristic boosts stay meaningful
  // regardless of upstream scoring method (cosine similarity, RRF, cross-encoder)
  const maxInputScore = results.reduce((max, r) => {
    const ceKey = `${r.payload.source_type}:${r.payload.source_id}:${r.payload.chunk_index}`;
    const s = crossEncoderScores?.get(ceKey) ?? r.score;
    return Math.max(max, s);
  }, 0);
  const normFactor = maxInputScore > 0 ? 1 / maxInputScore : 1;

  const ranked: RankedResult[] = results.map((r) => {
    const ceKey = `${r.payload.source_type}:${r.payload.source_id}:${r.payload.chunk_index}`;
    let score = (crossEncoderScores?.get(ceKey) ?? r.score) * normFactor;

    // Source type boost
    const sourceType = r.payload.source_type;
    const memCategory = r.payload.metadata?.category;
    if (sourceType === 'mcp_schema') score += 0.20;   // schema sections: always relevant for MCP queries
    else if (sourceType === 'skill') score += 0.08;    // lower: skills crowd out actionable context
    else if (sourceType === 'memory' && memCategory === 'tool_pattern') score += 0.15; // tool_patterns are high value
    else if (sourceType === 'memory') score += 0.05;   // preferences/corrections: lower priority
    else if (sourceType === 'knowledge') score += 0.10;
    else if (sourceType === 'chat_session') score += 0.02;  // low: session summaries rarely guide agent actions
    else if (sourceType === 'ci_pattern') score += 0.08;
    else if (sourceType === 'issue') score += 0.05;
    // comment: +0.00

    // Recency boost (max +0.10, linear decay over 30 days)
    const updatedAt = r.payload.metadata?.updatedAt;
    if (updatedAt) {
      const age = now - new Date(updatedAt).getTime();
      if (age < thirtyDays) {
        score += 0.10 * (1 - age / thirtyDays);
      }
    }

    // Status boost (for issues)
    const status = r.payload.metadata?.status;
    if (status === 'in_progress') score += 0.10;
    else if (status === 'approved') score += 0.08;
    else if (status === 'open') score += 0.05;
    else if (status === 'released') score -= 0.05;
    else if (status === 'closed') score -= 0.10;

    // Keyword overlap boost (text + metadata)
    if (queryWords.size > 0) {
      const text = r.payload.text.toLowerCase();
      const meta = r.payload.metadata || {};
      // Also search metadata fields for keyword matches
      const metaText = [meta.title, meta.status, meta.priority, meta.category]
        .filter(Boolean).join(' ').toLowerCase();
      const searchText = `${text} ${metaText}`;
      let overlap = 0;
      for (const word of queryWords) {
        if (searchText.includes(word)) overlap++;
      }
      score += Math.min(0.15, (overlap / queryWords.size) * 0.15);
    }

    // Has acceptance criteria boost (for issues)
    if (r.payload.metadata?.hasAC) score += 0.05;

    // Relation source boost (came from 1-hop traversal)
    if ((r as any)._fromRelation) score += 0.05;

    return { ...r, finalScore: score };
  });

  ranked.sort((a, b) => b.finalScore - a.finalScore);

  // Filter out user-scoped memories from other widget users
  // Project-scoped memories (tool_patterns, corrections) are shared with all users
  const filtered = ranked.filter((r) => {
    if (r.payload.source_type !== 'memory') return true;
    const meta = r.payload.metadata || {};
    if (meta.scope !== 'user') return true; // project-scoped: keep for all
    if (!widgetUserId) return true; // no user context: keep all (web/admin)
    if (!meta.widgetUserId) return true; // legacy memories without widgetUserId: keep
    return meta.widgetUserId === widgetUserId; // only show user's own memories
  });

  // Cap low-value source types to prevent crowding out actionable context
  // chat_session summaries restate what was asked, not what was learned —
  // tool_pattern and correction memories already capture useful outcomes
  const typeCaps: Record<string, number> = { chat_session: 1, comment: 2, skill: 1, memory: 3 };
  const typeCounts: Record<string, number> = {};
  const capped = filtered.filter((r) => {
    const st = r.payload.source_type;
    const cap = typeCaps[st];
    if (cap === undefined) return true;
    typeCounts[st] = (typeCounts[st] || 0) + 1;
    return typeCounts[st] <= cap;
  });

  return capped.slice(0, topK);
}

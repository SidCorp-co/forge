/**
 * Personalized PageRank over knowledge edges.
 * Used to score entities by relevance to seed entities during multi-hop traversal.
 */

import type { KnowledgeEdge } from './edge-store';

/**
 * Run Personalized PageRank on a set of edges with seed entities.
 * Returns a Map of entity -> score, filtered to score > threshold.
 */
export function personalizedPageRank(
  edges: KnowledgeEdge[],
  seedEntities: string[],
  damping = 0.85,
  maxIter = 10,
  threshold = 0.01,
): Map<string, number> {
  if (edges.length === 0 || seedEntities.length === 0) return new Map();

  // Build bidirectional adjacency list
  const adj = new Map<string, Set<string>>();

  const ensureNode = (entity: string) => {
    if (!adj.has(entity)) adj.set(entity, new Set());
  };

  for (const edge of edges) {
    const s = edge.subject;
    const o = edge.object;
    ensureNode(s);
    ensureNode(o);
    adj.get(s)!.add(o);
    adj.get(o)!.add(s);
  }

  // Personalization vector: uniform over seed entities present in the graph
  const personalization = new Map<string, number>();
  const seedWeight = 1 / seedEntities.length;
  for (const seed of seedEntities) {
    if (adj.has(seed)) {
      personalization.set(seed, seedWeight);
    }
  }

  if (personalization.size === 0) return new Map();

  let scores = new Map<string, number>();
  for (const node of adj.keys()) {
    scores.set(node, personalization.get(node) ?? 0);
  }

  const convergenceThreshold = 1e-6;

  for (let iter = 0; iter < maxIter; iter++) {
    const newScores = new Map<string, number>();
    let diff = 0;

    for (const [node, neighbors] of adj) {
      let score = (1 - damping) * (personalization.get(node) ?? 0);

      for (const neighbor of neighbors) {
        const neighborDegree = adj.get(neighbor)!.size;
        const neighborScore = scores.get(neighbor) ?? 0;
        score += damping * (neighborScore / neighborDegree);
      }

      newScores.set(node, score);
      diff += Math.abs(score - (scores.get(node) ?? 0));
    }

    scores = newScores;
    if (diff < convergenceThreshold) break;
  }

  const result = new Map<string, number>();
  for (const [entity, score] of scores) {
    if (score > threshold) {
      result.set(entity, Math.round(score * 1000) / 1000);
    }
  }

  return result;
}

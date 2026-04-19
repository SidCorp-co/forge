/**
 * Edge storage primitives for the knowledge graph.
 * Shared by index.ts and entity-extractor.ts to avoid circular imports.
 */

const EDGE_UID = 'api::knowledge-edge.knowledge-edge' as any;

export { EDGE_UID };

export interface EdgeInput {
  subject: string;
  predicate: string;
  object: string;
  value?: string;
  sourceMemoryId?: string;
}

export interface KnowledgeEdge extends EdgeInput {
  documentId: string;
  confidence: number;
  validFrom: string | null;
  validUntil: string | null;
}

/**
 * Upsert an edge — dedup by (project, subject, predicate, object).
 * If exists, update value + timestamp. If not, insert.
 */
export async function upsertEdge(
  strapi: any,
  projectId: string,
  edge: EdgeInput,
): Promise<KnowledgeEdge> {
  const docs = strapi.documents(EDGE_UID);

  // Check for existing edge
  const existing = await docs.findMany({
    filters: {
      project: { documentId: { $eq: projectId } },
      subject: { $eq: edge.subject },
      predicate: { $eq: edge.predicate },
      object: { $eq: edge.object },
      validUntil: { $null: true },
    },
    limit: 1,
  });

  const now = new Date().toISOString();

  if (existing.length > 0) {
    const row = existing[0];
    const updated = await docs.update({
      documentId: row.documentId,
      data: {
        value: edge.value ?? row.value,
        sourceMemoryId: edge.sourceMemoryId ?? row.sourceMemoryId,
        validFrom: now,
      },
    });
    return updated as KnowledgeEdge;
  }

  const created = await docs.create({
    data: {
      subject: edge.subject,
      predicate: edge.predicate,
      object: edge.object,
      value: edge.value || null,
      sourceMemoryId: edge.sourceMemoryId || null,
      confidence: 1.0,
      validFrom: now,
      validUntil: null,
      project: { documentId: projectId },
    },
  });

  return created as KnowledgeEdge;
}

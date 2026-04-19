import { upsertEmbedding, sanitizeContent } from './embeddings';

interface HrmDocument {
  id: string;
  title: string;
  content: string;
  category?: string;
}

/**
 * Sync HR knowledge documents (policies, handbook, org chart) into the RAG pipeline.
 * Fetches from the HRM Strapi instance and embeds as source_type: 'knowledge'.
 */
export async function syncHrmKnowledge(
  strapi: any,
  projectDocId: string,
  hrmBaseUrl: string,
  jwt: string,
): Promise<{ synced: number; errors: number }> {
  let synced = 0;
  let errors = 0;

  // Fetch knowledge documents from HRM
  const endpoints = [
    '/api/policies?pagination[pageSize]=100',
    '/api/handbooks?pagination[pageSize]=100',
    '/api/faqs?pagination[pageSize]=100',
  ];

  for (const endpoint of endpoints) {
    try {
      const res = await fetch(`${hrmBaseUrl}${endpoint}`, {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${jwt}`,
        },
      });
      if (!res.ok) continue;

      const json = await res.json() as any;
      const docs: HrmDocument[] = (json.data || []).map((d: any) => ({
        id: d.documentId || d.id,
        title: d.title || d.name || '',
        content: d.content || d.description || d.body || '',
        category: d.category || endpoint.split('/')[2]?.split('?')[0],
      }));

      for (const doc of docs) {
        try {
          await upsertEmbedding({
            project_id: projectDocId,
            source_type: 'knowledge',
            source_id: `hrm:${doc.id}`,
            text: sanitizeContent(`${doc.title}\n\n${doc.content}`),
            metadata: {
              title: doc.title,
              category: doc.category,
              source: 'hrm',
              updatedAt: new Date().toISOString(),
            },
          });
          synced++;
        } catch (err: any) {
          strapi.log.warn(`[hrm-sync] embed failed for ${doc.id}: ${err.message}`);
          errors++;
        }
      }
    } catch (err: any) {
      strapi.log.warn(`[hrm-sync] fetch failed for ${endpoint}: ${err.message}`);
      errors++;
    }
  }

  return { synced, errors };
}

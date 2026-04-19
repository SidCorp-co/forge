import { estimateCost } from '../../../services/pricing';

export async function bulkCreate(strapi: any, records: Record<string, unknown>[]) {
  const now = new Date().toISOString();
  const crypto = await import('crypto');
  const rows = records.map((r) => {
    const inputTokens = (r.inputTokens as number) || 0;
    const outputTokens = (r.outputTokens as number) || 0;
    const model = (r.model as string) || 'unknown';
    return {
      document_id: crypto.randomBytes(16).toString('hex').slice(0, 24),
      source: r.source || 'cli',
      model,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cache_read_tokens: (r.cacheReadTokens as number) || 0,
      cache_creation_tokens: (r.cacheCreationTokens as number) || 0,
      estimated_cost: estimateCost(model, inputTokens, outputTokens),
      request_count: (r.requestCount as number) || 1,
      session_id: r.sessionId || null,
      project_name: r.projectName || null,
      recorded_at: r.recordedAt || now,
      created_at: now,
      updated_at: now,
      published_at: now,
    };
  });

  // Raw Knex batch insert — much faster than individual document creates
  const knex = strapi.db.connection;
  const BATCH_SIZE = 500;
  let inserted = 0;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    await knex('usage_records').insert(batch);
    inserted += batch.length;
  }

  return inserted;
}

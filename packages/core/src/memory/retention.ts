import { sql } from 'drizzle-orm';
import { olderThan, type TableStatements } from '../pipeline/retention/shape.js';

export const retrievalAnalyticsRetention: TableStatements = {
  deleteBatch: (days, limit) => sql`
    DELETE FROM retrieval_analytics
    WHERE id IN (
      SELECT id FROM retrieval_analytics
      WHERE ${olderThan(sql`created_at`, days)}
      LIMIT ${limit}
    )
    RETURNING id
  `,
  heldBack: null,
};

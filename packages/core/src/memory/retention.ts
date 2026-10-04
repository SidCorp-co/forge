import { type SQL, sql } from 'drizzle-orm';

/** retrieval_analytics' rule for the retention sweep, in the sweep's `TableStatements` shape: past the window it goes, and nothing is held back. */
export const retrievalAnalyticsRetention: {
  deleteBatch: (days: number, limit: number) => SQL;
  heldBack: null;
} = {
  deleteBatch: (days, limit) => sql`
    DELETE FROM retrieval_analytics
    WHERE id IN (
      SELECT id FROM retrieval_analytics
      WHERE created_at < now() - make_interval(days => ${days})
      LIMIT ${limit}
    )
    RETURNING id
  `,
  heldBack: null,
};

import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { appConfig } from '../db/schema.js';

/** The two per-project retrieval switches the search service reads (ISS-904 landed the columns; ISS-905 reads them). */
export interface RetrievalFlags {
  rerank: boolean;
  expandRelations: boolean;
}

export const RETRIEVAL_FLAGS_OFF: RetrievalFlags = { rerank: false, expandRelations: false };

/** A project that never saved an `app_config` row has both flags off, which is exactly the pre-v3 behaviour. */
export async function loadRetrievalFlags(projectId: string): Promise<RetrievalFlags> {
  const [row] = await db
    .select({
      rerank: appConfig.retrievalRerank,
      expandRelations: appConfig.retrievalExpandRelations,
    })
    .from(appConfig)
    .where(eq(appConfig.projectId, projectId))
    .limit(1);
  return row ?? RETRIEVAL_FLAGS_OFF;
}

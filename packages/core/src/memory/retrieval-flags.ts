import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { appConfig, type MemoryModel } from '../db/schema.js';

/** The per-project retrieval switches the search service and the indexer read (ISS-904 landed the columns; ISS-905 and ISS-906 read them). */
export interface RetrievalFlags {
  rerank: boolean;
  expandRelations: boolean;
  memoryModel: MemoryModel;
}

export const RETRIEVAL_FLAGS_OFF: RetrievalFlags = {
  rerank: false,
  expandRelations: false,
  memoryModel: 'flat',
};

/** A project that never saved an `app_config` row has both flags off, which is exactly the pre-v3 behaviour. */
export async function loadRetrievalFlags(projectId: string): Promise<RetrievalFlags> {
  const [row] = await db
    .select({
      rerank: appConfig.retrievalRerank,
      expandRelations: appConfig.retrievalExpandRelations,
      memoryModel: appConfig.memoryModel,
    })
    .from(appConfig)
    .where(eq(appConfig.projectId, projectId))
    .limit(1);
  return row ?? RETRIEVAL_FLAGS_OFF;
}

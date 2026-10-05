/** The retrieval switches the memory search reads: both off, the behaviour every project has had. */
export interface RetrievalFlags {
  rerank: boolean;
  expandRelations: boolean;
}

export const RETRIEVAL_FLAGS: RetrievalFlags = { rerank: false, expandRelations: false };

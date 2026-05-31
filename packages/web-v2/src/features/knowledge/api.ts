// web-v2 feature module: knowledge — REST surface. Routes verified against
// `packages/core/src/knowledge-edges/routes.ts` + `knowledge/ingest-routes.ts`.
import { apiClient } from "@/lib/api/client";
import type { IngestDocument, IngestResult, KnowledgeEdge } from "./types";

export const knowledgeApi = {
  /** `GET /api/knowledge-edges?projectId=&limit=` — newest first. */
  listEdges: (projectId: string, limit = 200) =>
    apiClient<KnowledgeEdge[]>(
      `/knowledge-edges?projectId=${encodeURIComponent(projectId)}&limit=${limit}`,
    ),

  /** `DELETE /api/knowledge-edges/:id` — 204; owner only. */
  deleteEdge: (id: string) =>
    apiClient<void>(`/knowledge-edges/${id}`, { method: "DELETE" }),

  /** `POST /api/knowledge/ingest` — chunk + embed user docs (JSON, not multipart;
   *  file uploads are read client-side and sent as `content`). Rate-limited. */
  ingest: (projectId: string, documents: IngestDocument[]) =>
    apiClient<IngestResult>(`/knowledge/ingest`, {
      method: "POST",
      body: JSON.stringify({ projectId, documents }),
    }),
};

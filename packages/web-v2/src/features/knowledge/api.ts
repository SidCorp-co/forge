// web-v2 feature module: knowledge — REST surface. Routes verified against
// `packages/core/src/knowledge-edges/routes.ts` + `knowledge/ingest-routes.ts`
// + `knowledge/routes.ts` (P1/ISS-565).
import { apiClient } from "@/lib/api/client";
import type {
  IngestDocument,
  IngestResult,
  KnowledgeEdge,
  KnowledgeEntry,
  ListKnowledgeResponse,
  UpsertKnowledgeBody,
  UpsertKnowledgeResult,
} from "./types";

export const knowledgeApi = {
  // --- Knowledge Entries (P1 REST /api/projects/:id/knowledge) ---

  /** `GET /api/projects/:id/knowledge?kind=&injection=` — body-free list. */
  listEntries: (projectId: string, params?: { kind?: string; injection?: string }) => {
    const sp = new URLSearchParams();
    if (params?.kind) sp.set("kind", params.kind);
    if (params?.injection) sp.set("injection", params.injection);
    const qs = sp.toString();
    return apiClient<ListKnowledgeResponse>(
      `/projects/${encodeURIComponent(projectId)}/knowledge${qs ? `?${qs}` : ""}`,
    );
  },

  /** `GET /api/projects/:id/knowledge/:slug` — full entry incl. body. */
  getEntry: (projectId: string, slug: string) =>
    apiClient<KnowledgeEntry>(
      `/projects/${encodeURIComponent(projectId)}/knowledge/${encodeURIComponent(slug)}`,
    ),

  /** `PUT /api/projects/:id/knowledge/:slug` — upsert. */
  upsertEntry: (projectId: string, slug: string, body: UpsertKnowledgeBody) =>
    apiClient<UpsertKnowledgeResult>(
      `/projects/${encodeURIComponent(projectId)}/knowledge/${encodeURIComponent(slug)}`,
      { method: "PUT", body: JSON.stringify(body) },
    ),

  /** `DELETE /api/projects/:id/knowledge/:slug` → `{ deleted: boolean }`. */
  deleteEntry: (projectId: string, slug: string) =>
    apiClient<{ deleted: boolean }>(
      `/projects/${encodeURIComponent(projectId)}/knowledge/${encodeURIComponent(slug)}`,
      { method: "DELETE" },
    ),

  // --- Knowledge Edges ---

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

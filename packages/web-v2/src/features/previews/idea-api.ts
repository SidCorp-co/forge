// The REST surface of an idea preview (REQ-41 BC-14, BC-16), through the contracts' `PREVIEW_ROUTES`
// so a route that moves there moves here. Core answers are read through the contract's own schemas
// and refused by name when they are not them, as `api.ts` does for an issue's preview.

import {
  type KeepPreviewRequest,
  type KeepPreviewResponse,
  keepPreviewResponseSchema,
  PREVIEW_ROUTES,
  type PreviewRecord,
  previewEnvelopeSchema,
} from "@forge/contracts/preview";
import { apiClient } from "@/lib/api/client";
import { post, read, routeOf } from "./api";

export const ideaApi = {
  /** Opens a preview of an idea about a requirement or a feedback item, optionally from a kept preview's branch head. */
  open: async (projectId: string, body: { about: string; brief: string; from?: string }): Promise<PreviewRecord> =>
    read("POST idea preview", previewEnvelopeSchema, await post(PREVIEW_ROUTES.ofProject, { id: projectId }, { kind: "idea", ...body })).preview,

  get: async (id: string): Promise<PreviewRecord> =>
    read("GET preview", previewEnvelopeSchema, await apiClient<unknown>(routeOf(PREVIEW_ROUTES.get, { id }))).preview,

  /** Keeps the idea as its requirement's picture, with the page as the page's own recorder snapshotted it. */
  keep: async (id: string, body: KeepPreviewRequest): Promise<KeepPreviewResponse> =>
    read("POST keep", keepPreviewResponseSchema, await post(PREVIEW_ROUTES.keep, { id }, body)),
};

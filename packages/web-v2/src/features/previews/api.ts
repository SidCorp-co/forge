// The REST surface of live previews (REQ-39), addressed through the contracts' `PREVIEW_ROUTES` so a
// route that moves there moves here. Core owns the record; a body that is not `previewRecordSchema`
// is refused by name rather than drawn from, since a drifted record would draw a preview in a state
// nothing here knows.

import type { LaneDecision } from "@forge/contracts/fast-lane";
import {
  issuePreviewResponseSchema,
  PREVIEW_ROUTES,
  type PreviewApproveResponse,
  type PreviewRecord,
  previewApproveResponseSchema,
  previewEnvelopeSchema,
  previewMessageResponseSchema,
  previewTicketResponseSchema,
} from "@forge/contracts/preview";
import type { z } from "zod";
import { apiClient } from "@/lib/api/client";

const routeOf = (route: string, params: Record<string, string>): string => {
  const path = route.replace(/:(\w+)/g, (_, name: string) => {
    const value = params[name];
    if (value === undefined) throw new Error(`previews/api: ${route} needs :${name}`);
    return encodeURIComponent(value);
  });
  // the contracts name the full path; the client prefixes `/api` itself
  return path.replace(/^\/api/, "");
};

export class PreviewRecordRefused extends Error {
  constructor(where: string, issues: string) {
    super(`${where} answered a preview this build cannot read: ${issues}`);
    this.name = "PreviewRecordRefused";
  }
}

/** A body read through the contract's own schema; a body that is not it is refused by name, never drawn from. */
function read<S extends z.ZodType>(where: string, schema: S, body: unknown): z.infer<S> {
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new PreviewRecordRefused(where, parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"} ${i.message}`).join("; "));
  return parsed.data;
}

const post = (route: string, params: Record<string, string>, body?: unknown) =>
  apiClient<unknown>(routeOf(route, params), { method: "POST", ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

/** `GET /api/issues/:id/lane` (fast-lane): the lane the issue's approved change takes, and why not the fast one. */
export interface IssueLane {
  issueId: string;
  lane: "fast" | "full";
  decision: LaneDecision | null;
  approved: { patchId: string; approvedAt: string } | null;
  refusal: { code: string; path: string; detail: string } | null;
}

export const previewsApi = {
  /** The issue's latest preview, or null where it has had none; a display key is scoped by `projectId`. */
  ofIssue: async (issueId: string, projectId?: string): Promise<PreviewRecord | null> => {
    const path = routeOf(PREVIEW_ROUTES.ofIssue, { issueId });
    const scoped = projectId ? `${path}?projectId=${encodeURIComponent(projectId)}` : path;
    return read("GET preview of issue", issuePreviewResponseSchema, await apiClient<unknown>(scoped)).preview;
  },

  /** Opens the preview of the issue's live run, or reopens its idle-closed one at the same link. */
  open: async (issueId: string): Promise<PreviewRecord> =>
    read("POST preview of issue", previewEnvelopeSchema, await post(PREVIEW_ROUTES.ofIssue, { issueId })).preview,

  approve: async (id: string): Promise<PreviewApproveResponse> =>
    read("POST approve", previewApproveResponseSchema, await post(PREVIEW_ROUTES.approve, { id })),

  abandon: async (id: string): Promise<PreviewRecord> =>
    read("POST abandon", previewEnvelopeSchema, await post(PREVIEW_ROUTES.abandon, { id }, {})).preview,

  /** A person's request for a change, sent to the run holding the preview (BC-6). */
  message: async (id: string, text: string) =>
    read("POST messages", previewMessageResponseSchema, await post(PREVIEW_ROUTES.messages, { id }, { text })),

  /** The address that spends a one-time ticket on the preview host: it sets the viewer cookie and lands on `/`. */
  ticketUrl: async (id: string): Promise<string> => read("POST ticket", previewTicketResponseSchema, await post(PREVIEW_ROUTES.ticket, { id })).url,

  lane: (issueId: string) => apiClient<IssueLane>(`/issues/${encodeURIComponent(issueId)}/lane`),
};

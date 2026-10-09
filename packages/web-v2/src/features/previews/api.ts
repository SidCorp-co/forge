// The REST surface of live previews (REQ-39), addressed through the contracts' `PREVIEW_ROUTES` so a
// route that moves there moves here. Core owns the record; a body that is not `previewRecordSchema`
// is refused by name rather than drawn from, since a drifted record would draw a preview in a state
// nothing here knows.

import type { LaneDecision } from "@forge/contracts/fast-lane";
import {
  PREVIEW_ENTER_PATH,
  PREVIEW_ROUTES,
  type PreviewRecord,
  previewRecordSchema,
} from "@forge/contracts/preview";
import { z } from "zod";
import { apiClient, ApiError } from "@/lib/api/client";

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

function recordOf(where: string, body: unknown): PreviewRecord {
  const parsed = previewRecordSchema.safeParse(body);
  if (!parsed.success) throw new PreviewRecordRefused(where, parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"} ${i.message}`).join("; "));
  return parsed.data;
}

/** What `POST /api/previews/:id/ticket` answers: the one-time ticket the preview host turns into its viewer cookie. */
const ticketSchema = z.strictObject({ ticket: z.string().min(1) });

/** `GET /api/issues/:id/lane` (fast-lane): the lane the issue's approved change takes, and why not the fast one. */
export interface IssueLane {
  issueId: string;
  lane: "fast" | "full";
  decision: LaneDecision | null;
  approved: { patchId: string; approvedAt: string } | null;
  refusal: { code: string; path: string; detail: string } | null;
}

export const previewsApi = {
  /** The issue's latest preview, or null where it has had none. */
  ofIssue: async (issueId: string): Promise<PreviewRecord | null> => {
    try {
      const body = await apiClient<unknown>(routeOf(PREVIEW_ROUTES.ofIssue, { issueId }));
      return body === null || body === undefined ? null : recordOf("GET preview of issue", body);
    } catch (err) {
      if (err instanceof ApiError && err.code === "PREVIEW_NOT_FOUND") return null;
      throw err;
    }
  },

  /** Opens the preview of the issue's live run, or reopens its idle-closed one at the same link. */
  open: async (issueId: string): Promise<PreviewRecord> =>
    recordOf("POST preview of issue", await apiClient<unknown>(routeOf(PREVIEW_ROUTES.ofIssue, { issueId }), { method: "POST" })),

  approve: async (id: string): Promise<PreviewRecord> =>
    recordOf("POST approve", await apiClient<unknown>(routeOf(PREVIEW_ROUTES.approve, { id }), { method: "POST" })),

  abandon: async (id: string): Promise<PreviewRecord> =>
    recordOf("POST abandon", await apiClient<unknown>(routeOf(PREVIEW_ROUTES.abandon, { id }), { method: "POST" })),

  /** A person's request for a change, sent to the run holding the preview (BC-6). */
  message: (id: string, text: string) =>
    apiClient<unknown>(routeOf(PREVIEW_ROUTES.messages, { id }), { method: "POST", body: JSON.stringify({ text }) }),

  /** A one-time, one-minute ticket; the address that spends it is `enterUrl`. */
  ticket: async (id: string): Promise<string> => {
    const body = await apiClient<unknown>(routeOf(PREVIEW_ROUTES.ticket, { id }), { method: "POST" });
    const parsed = ticketSchema.safeParse(body);
    if (!parsed.success) throw new PreviewRecordRefused("POST ticket", "expected { ticket }");
    return parsed.data.ticket;
  },

  lane: (issueId: string) => apiClient<IssueLane>(`/issues/${encodeURIComponent(issueId)}/lane`),
};

/** The address that turns a ticket into the viewer cookie on the preview host and lands on `/`. */
export function enterUrl(preview: Pick<PreviewRecord, "url">, ticket: string): string {
  const url = new URL(PREVIEW_ENTER_PATH, preview.url);
  url.searchParams.set("ticket", ticket);
  return url.toString();
}

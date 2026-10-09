// The REST surface a reproduce reads and writes (REQ-41 BC-17..BC-21), through the contracts' own
// routes and schemas: open a reproduce of a feedback item, read it, read its recordings and their
// events for replay, stop one, say Fixed or Not fixed on a fix preview, and press the diagnosis's
// recommended answer, which is the item's own issue route.

import type { RecordingDiagnosis } from "@forge/contracts/feedback";
import { PREVIEW_ROUTES, type PreviewRecord, previewEnvelopeSchema } from "@forge/contracts/preview";
import {
  type ConfirmFixResponse,
  confirmFixResponseSchema,
  RECORDING_ROUTES,
  type RecordingRecord,
  type RrwebEvent,
  recordingEnvelopeSchema,
  recordingEventsResponseSchema,
  recordingsResponseSchema,
} from "@forge/contracts/reproduce";
import { apiClient } from "@/lib/api/client";
import { read, routeOf } from "./api";

const send = (route: string, params: Record<string, string>, method: "POST" | "GET", body?: unknown) =>
  apiClient<unknown>(routeOf(route, params), { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

/** What a triage answers that the chat reads back: the route and what carries it. */
interface Triaged {
  feedback: { key: string; route: { route: string; carriers: { key: string | null }[] } | null };
}

export const reproduceApi = {
  /** Opens a reproduce of `feedback` on the build its reporter used; core names the build or refuses PREVIEW_BUILD_UNKNOWN. */
  open: async (projectId: string, feedback: string): Promise<PreviewRecord> =>
    read("POST reproduce", previewEnvelopeSchema, await send(PREVIEW_ROUTES.ofProject, { id: projectId }, "POST", { kind: "reproduce", feedback })).preview,

  get: async (id: string): Promise<PreviewRecord> => read("GET preview", previewEnvelopeSchema, await send(PREVIEW_ROUTES.get, { id }, "GET")).preview,

  /** A feedback item's recordings, newest first; members only (RECORDING_FORBIDDEN). */
  recordings: async (projectId: string, feedback: string): Promise<RecordingRecord[]> =>
    read("GET recordings", recordingsResponseSchema, await send(RECORDING_ROUTES.ofFeedback, { id: projectId, fb: feedback }, "GET")).recordings,

  /** The scrubbed rrweb events, for replay, while within retention (RECORDING_EXPIRED after). */
  events: async (id: string): Promise<RrwebEvent[]> => read("GET recording events", recordingEventsResponseSchema, await send(RECORDING_ROUTES.events, { id }, "GET")).events,

  stop: async (id: string): Promise<RecordingRecord> => read("POST stop recording", recordingEnvelopeSchema, await send(RECORDING_ROUTES.stop, { id }, "POST")).recording,

  /** The reporter's word on a fix preview, bound by core to the patch it serves now. */
  confirm: async (previewId: string, verdict: "fixed" | "not_fixed", note?: string): Promise<ConfirmFixResponse> =>
    read("POST confirm", confirmFixResponseSchema, await send(PREVIEW_ROUTES.confirm, { id: previewId }, "POST", verdict === "fixed" ? { verdict } : { verdict, note })),

  /** The recommended answer to a diagnosis: the item's issue route, carrying the cause and the fix, as the person who presses it. */
  buildTheFix: (projectId: string, feedback: string, diagnosis: RecordingDiagnosis): Promise<Triaged> =>
    apiClient<Triaged>(`/projects/${encodeURIComponent(projectId)}/feedback/${encodeURIComponent(feedback)}/triage`, {
      method: "POST",
      body: JSON.stringify({ route: "issue", diagnosis }),
    }),
};

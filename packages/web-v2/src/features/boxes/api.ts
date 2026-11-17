// The Forge Box doors (ISS-1276, ADR 0015), addressed through the contracts' `BOX_ROUTES` so a route
// that moves there moves here. Core owns the record and every decision; a body whose box names a
// state or mode this build does not know is refused by name rather than drawn from.

import {
  BOX_MODES,
  BOX_ROUTES,
  BOX_STATES,
  type BoxActRecord,
  type BoxRecord,
  type BoxSpanRecord,
  type OpenBoxRequest,
} from "@forge/contracts/boxes";
import { apiClient } from "@/lib/api/client";
import { routeOf } from "@/lib/api/route-of";
import { CORE_URL } from "@/lib/utils/core-url";

class BoxRecordRefused extends Error {
  constructor(where: string, what: string) {
    super(`${where} answered a box this build cannot read: ${what}`);
    this.name = "BoxRecordRefused";
  }
}

function readBox(where: string, body: unknown): BoxRecord {
  const box = body as BoxRecord | null;
  if (!box || typeof box.id !== "string") throw new BoxRecordRefused(where, "no box id");
  if (!(BOX_STATES as readonly string[]).includes(box.state)) throw new BoxRecordRefused(where, `state ${String(box.state)}`);
  if (!(BOX_MODES as readonly string[]).includes(box.mode)) throw new BoxRecordRefused(where, `mode ${String(box.mode)}`);
  return box;
}

const post = <T>(route: string, params: Record<string, string>, body: unknown = {}) =>
  apiClient<T>(routeOf(route, params), { method: "POST", body: JSON.stringify(body) });

/** The socket address a ticket's `url` names (`/ws/boxes/view?ticket=…`), on core's own origin. */
export function boxSocketUrl(path: string, fps?: number): string {
  const url = new URL(`${CORE_URL}${path}`, window.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  if (fps !== undefined) url.searchParams.set("fps", String(fps));
  return url.toString();
}

/** What a box row names its issue by: its key and title, read from the issue itself. */
export interface BoxIssueLabel {
  key: string;
  title: string;
}

export const boxesApi = {
  /** One box by its id: a box the caller cannot read is refused by core, by name. */
  one: async (id: string): Promise<BoxRecord> => readBox("GET box", (await apiClient<{ box: unknown }>(routeOf(BOX_ROUTES.get, { id }))).box),

  ofProject: async (projectId: string): Promise<BoxRecord[]> => {
    const body = await apiClient<{ boxes: unknown[] }>(routeOf(BOX_ROUTES.ofProject, { id: projectId }));
    return body.boxes.map((b) => readBox("GET boxes", b));
  },

  open: async (projectId: string, request: OpenBoxRequest): Promise<BoxRecord> =>
    readBox("POST boxes", (await post<{ box: unknown }>(BOX_ROUTES.ofProject, { id: projectId }, request)).box),

  take: async (id: string): Promise<BoxRecord> => readBox("POST take", (await post<{ box: unknown }>(BOX_ROUTES.take, { id })).box),

  release: async (id: string): Promise<BoxRecord> => readBox("POST release", (await post<{ box: unknown }>(BOX_ROUTES.release, { id })).box),

  close: async (id: string): Promise<BoxRecord> => readBox("POST close", (await post<{ box: unknown }>(BOX_ROUTES.close, { id })).box),

  /** Start or stop the box's recording: nothing records unless asked (ISS-1321). */
  recording: async (id: string, on: boolean): Promise<BoxRecord> =>
    readBox("POST recording", (await post<{ box: unknown }>(BOX_ROUTES.recording, { id }, { on })).box),

  acts: async (id: string): Promise<BoxActRecord[]> => (await apiClient<{ acts: BoxActRecord[] }>(routeOf(BOX_ROUTES.acts, { id }))).acts,

  spans: async (id: string): Promise<BoxSpanRecord[]> => (await apiClient<{ spans: BoxSpanRecord[] }>(routeOf(BOX_ROUTES.spans, { id }))).spans,

  /** A one-minute ticket for one socket, spent once. */
  ticket: (id: string, channel: "view" | "input") =>
    post<{ ticket: string; expiresAt: string; url: string }>(BOX_ROUTES.ticket, { id }, { channel }),

  issueLabel: async (issueId: string): Promise<BoxIssueLabel> => {
    const issue = await apiClient<{ displayId?: string | null; title?: string | null }>(`/issues/${encodeURIComponent(issueId)}`);
    return { key: issue.displayId ?? "", title: issue.title ?? "" };
  },
};

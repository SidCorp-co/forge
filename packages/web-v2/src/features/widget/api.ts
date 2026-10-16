import {
  WIDGET_REFUSAL_CODES,
  type WidgetFeedbackDraft,
  type WidgetFiled,
  type WidgetHistory,
  type WidgetMessageAccepted,
  type WidgetPageContext,
  type WidgetPublicConfig,
  type WidgetRefusalCode,
  type WidgetSession,
  type WidgetSessionRequest,
  type WidgetStatus,
} from "@forge/contracts/widget";
import { CORE_URL } from "@/lib/utils/core-url";

// The visitor's side of core's widget routes (packages/contracts/src/widget.ts). The visitor is not a
// Forge user, so nothing here goes through the app's API client: no cookie is sent, and a refusal is
// never read as a Forge session ending.

export const WIDGET_API = `${CORE_URL}/api/widget`;

/** A refusal core answered, by its code; `code` is null where the answer named none of the widget's. */
export class WidgetRefusal extends Error {
  readonly status: number;
  readonly code: WidgetRefusalCode | null;
  readonly rawCode: string | null;

  constructor(status: number, rawCode: string | null, message: string) {
    super(message);
    this.name = "WidgetRefusal";
    this.status = status;
    this.rawCode = rawCode;
    this.code = isWidgetCode(rawCode) ? rawCode : null;
  }
}

/** The request never reached core: the network, not a refusal. */
export class WidgetUnreachable extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "WidgetUnreachable";
  }
}

export function isWidgetCode(code: unknown): code is WidgetRefusalCode {
  return typeof code === "string" && (WIDGET_REFUSAL_CODES as readonly string[]).includes(code);
}

/** The refusal a non-2xx answer carries: core's problem body names its code at the top level. */
export async function refusalOf(res: Response): Promise<WidgetRefusal> {
  let code: string | null = null;
  let message = res.statusText || `HTTP ${res.status}`;
  try {
    const body = (await res.json()) as { code?: unknown; message?: unknown; error?: { code?: unknown } };
    const named = typeof body.code === "string" ? body.code : body.error?.code;
    if (typeof named === "string") code = named;
    if (typeof body.message === "string") message = body.message;
  } catch {
    // a body that is not JSON names no code; the status still stands
  }
  return new WidgetRefusal(res.status, code, message);
}

export async function send(path: string, init: RequestInit = {}, token?: string): Promise<Response> {
  const headers = new Headers(init.headers);
  if (init.body !== undefined) headers.set("Content-Type", "application/json");
  if (token) headers.set("Authorization", `Bearer ${token}`);
  let res: Response;
  try {
    res = await fetch(`${WIDGET_API}${path}`, { ...init, headers, credentials: "omit" });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    throw new WidgetUnreachable(err);
  }
  if (!res.ok) throw await refusalOf(res);
  return res;
}

async function json<T>(path: string, init: RequestInit = {}, token?: string): Promise<T> {
  const res = await send(path, init, token);
  return (await res.json()) as T;
}

const post = (body: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(body) });
const site = (siteKey: string) => `/${encodeURIComponent(siteKey)}`;

export const widgetApi = {
  config: (siteKey: string) => json<WidgetPublicConfig>(`${site(siteKey)}/config`),
  openSession: (siteKey: string, body: WidgetSessionRequest) =>
    json<WidgetSession>(`${site(siteKey)}/sessions`, post(body)),
  history: (token: string) => json<WidgetHistory>("/session/messages", {}, token),
  /** The visitor's line as core stored it; the reply, and any draft, come on the stream. */
  sendMessage: async (token: string, text: string, context?: WidgetPageContext) => {
    const accepted = await json<Partial<WidgetMessageAccepted> | null>("/session/messages", post(context ? { text, context } : { text }), token);
    if (typeof accepted?.message?.id !== "string") throw new Error("core accepted the message but its answer carries no message");
    return accepted.message;
  },
  confirm: (token: string, draftId: string) =>
    json<WidgetFiled>(`/session/drafts/${encodeURIComponent(draftId)}/confirm`, { method: "POST" }, token),
  discard: (token: string, draftId: string) =>
    json<WidgetFeedbackDraft>(`/session/drafts/${encodeURIComponent(draftId)}/discard`, { method: "POST" }, token),
  status: (token: string) => json<WidgetStatus>(`/status/${encodeURIComponent(token)}`),
};

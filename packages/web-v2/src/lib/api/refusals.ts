import { ApiError } from "./client";

/** One named refusal: what was refused, where, and why, exactly as core named it. */
export interface Refusal {
  code: string;
  path: string;
  detail: string;
}

const isRefusal = (r: unknown): r is Refusal => {
  if (!r || typeof r !== "object") return false;
  const x = r as Record<string, unknown>;
  return typeof x.code === "string" && typeof x.path === "string" && typeof x.detail === "string";
};

const listed = (rows: unknown): Refusal[] => (Array.isArray(rows) ? rows.filter(isRefusal) : []);

type Envelope = { code?: unknown; message?: unknown; refusals?: unknown } | undefined;

const envelopeOf = (err: ApiError): Envelope => (err.body as { error?: Envelope } | undefined)?.error;

/** The refusals a document write's 422 envelope names, and nothing for any other failure. */
export function documentRefusals(err: unknown): Refusal[] {
  if (!(err instanceof ApiError) || err.status !== 422) return [];
  return listed(envelopeOf(err)?.refusals);
}

/**
 * Every refusal a failed request carries, whichever of core's two shapes it came in: the
 * `{ error: { code, refusals } }` envelope a document refusal answers with, or the
 * `{ code, message, details: { refusals } }` an HTTP refusal answers with. A failure that names
 * nothing is still returned as one row naming its status, so no caller can render it as nothing.
 */
export function refusalsOf(err: unknown): Refusal[] {
  if (err instanceof ApiError) {
    const envelope = envelopeOf(err);
    const fromEnvelope = listed(envelope?.refusals);
    if (fromEnvelope.length > 0) return fromEnvelope;
    const fromDetails = listed((err.details as { refusals?: unknown } | undefined)?.refusals);
    if (fromDetails.length > 0) return fromDetails;
    const code =
      err.code ?? (typeof envelope?.code === "string" ? envelope.code : `HTTP_${err.status}`);
    const detail =
      typeof envelope?.message === "string" ? envelope.message : err.message || `request failed (${err.status})`;
    return [{ code, path: "", detail }];
  }
  if (err instanceof Error) return [{ code: "REQUEST_FAILED", path: "", detail: err.message }];
  return [{ code: "REQUEST_FAILED", path: "", detail: String(err) }];
}

export const refusalLine = (r: Refusal) => `${r.code} at ${r.path || "/"}: ${r.detail}`;

/** What a read came back as. `unread` is never `empty`: a list that could not be read says so. */
export type Reading<T> =
  | { kind: "loading" }
  | { kind: "unread"; refusals: Refusal[] }
  | { kind: "read"; value: T };

export function readingOf<T>(q: {
  data: T | undefined;
  error: unknown;
  isError: boolean;
}): Reading<T> {
  if (q.isError) return { kind: "unread", refusals: refusalsOf(q.error) };
  if (q.data === undefined) return { kind: "loading" };
  return { kind: "read", value: q.data };
}

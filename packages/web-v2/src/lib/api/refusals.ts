import { ApiError } from "./client";

import type { Refusal } from "@forge/contracts";

/** One named refusal, exactly as core named it: declared once in `@forge/contracts`. */
export type { Refusal };

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

/** Only the refusals core listed, in either shape; nothing for a failure that named none. */
export function namedRefusals(err: unknown): Refusal[] {
  if (!(err instanceof ApiError)) return [];
  const fromEnvelope = listed(envelopeOf(err)?.refusals);
  if (fromEnvelope.length > 0) return fromEnvelope;
  return listed((err.details as { refusals?: unknown } | undefined)?.refusals);
}

/**
 * Every refusal a failed request carries, whichever of core's two shapes it came in: the
 * `{ error: { code, refusals } }` envelope a document refusal answers with, or the
 * `{ code, message, details: { refusals } }` an HTTP refusal answers with. A failure that names
 * nothing is still returned as one row naming its status, so no caller can render it as nothing.
 */
export function refusalsOf(err: unknown): Refusal[] {
  if (err instanceof ApiError) {
    const named = namedRefusals(err);
    if (named.length > 0) return named;
    const envelope = envelopeOf(err);
    const code =
      err.code ?? (typeof envelope?.code === "string" ? envelope.code : `HTTP_${err.status}`);
    const detail =
      typeof envelope?.message === "string" ? envelope.message : err.message || `request failed (${err.status})`;
    return [{ code, path: "", detail }];
  }
  if (err instanceof Error) return [{ code: "REQUEST_FAILED", path: "", detail: err.message }];
  return [{ code: "REQUEST_FAILED", path: "", detail: String(err) }];
}

/**
 * What a person reads of a refusal core worded for an API caller: the field it names, by label,
 * and a sentence pointing at the screen that fixes it. Keyed by code and path; a refusal with no
 * entry reads as core wrote it, under its path.
 */
const READINGS: Record<string, { label?: string; sentence?: string }> = {
  "HOLD_NOT_AUTHORISED /by": {
    label: "Who holds",
    sentence:
      "Holding or releasing a conversation takes a member role or above on the side it is held for, and you do not hold one there.",
  },
  "HOLD_NOT_AUTHORISED /side": {
    label: "Side",
    sentence: "Only the sender or a recipient of the conversation holds it.",
  },
  SECRET_NOT_FOUND: {
    sentence: "This secret is not stored in this project. Store it under Secrets on the Config tab, then save again.",
  },
};

export interface RefusalReading {
  code: string;
  /** The field's label, else its path; null for a refusal of the whole request. */
  where: string | null;
  sentence: string;
}

export function readRefusal(r: Refusal): RefusalReading {
  const reading = READINGS[`${r.code} ${r.path}`] ?? READINGS[r.code] ?? {};
  return { code: r.code, where: reading.label ?? (r.path || null), sentence: reading.sentence ?? r.detail };
}

export const refusalLine = (r: Refusal) => {
  const { code, where, sentence } = readRefusal(r);
  return `${code} at ${where ?? "/"}: ${sentence}`;
};

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

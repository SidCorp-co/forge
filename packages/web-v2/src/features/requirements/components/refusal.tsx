"use client";

import { ApiError } from "@/lib/api/client";
import { formatApiError } from "@/lib/api/error";

interface Refusal {
  code: string | null;
  detail: string;
}

/** Core refuses a requirement write as `{ error: { code, message, refusals: [{ code, path, detail }] } }`. */
export function readRefusal(err: unknown): Refusal {
  if (err instanceof ApiError && err.body && typeof err.body === "object") {
    const e = (err.body as { error?: unknown }).error;
    if (e && typeof e === "object") {
      const { code, message, refusals } = e as { code?: unknown; message?: unknown; refusals?: unknown };
      const first = Array.isArray(refusals) ? (refusals[0] as { code?: unknown; path?: unknown; detail?: unknown }) : null;
      if (first && typeof first.detail === "string") {
        const at = typeof first.path === "string" && first.path ? ` (${first.path})` : "";
        const more = Array.isArray(refusals) && refusals.length > 1 ? ` · ${refusals.length - 1} more` : "";
        return { code: typeof first.code === "string" ? first.code : null, detail: `${first.detail}${at}${more}` };
      }
      if (typeof message === "string") return { code: typeof code === "string" ? code : null, detail: message };
    }
  }
  return { code: err instanceof ApiError ? (err.code ?? null) : null, detail: formatApiError(err) };
}

/** A refusal is one tinted line: the code, then what was wrong. */
export function RefusalLine({ error }: { error: unknown }) {
  if (!error) return null;
  const r = readRefusal(error);
  return (
    <p
      role="alert"
      className="flex min-w-0 items-baseline gap-2 px-3 py-1.5 text-12"
      style={{ color: "var(--red-600)", background: "var(--red-50)" }}
      data-testid="requirement-refusal"
    >
      {r.code ? <span className="shrink-0 font-mono font-semibold">{r.code}</span> : null}
      <span className="min-w-0">{r.detail}</span>
    </p>
  );
}

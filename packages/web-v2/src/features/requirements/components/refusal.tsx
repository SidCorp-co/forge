"use client";

import { ApiError } from "@/lib/api/client";
import { formatApiError } from "@/lib/api/error";
import { namedRefusals } from "@/lib/api/refusals";

/** The first refusal core named, with how many more; a failure that named none reads as `formatApiError` words it. */
function lineOf(err: unknown): { code: string | null; detail: string } {
  const [first, ...rest] = namedRefusals(err);
  if (!first) return { code: err instanceof ApiError ? (err.code ?? null) : null, detail: formatApiError(err) };
  const at = first.path ? ` (${first.path})` : "";
  const more = rest.length > 0 ? ` · ${rest.length} more` : "";
  return { code: first.code, detail: `${first.detail}${at}${more}` };
}

/** A refusal is one tinted line: the code, then what was wrong. */
export function RefusalLine({ error }: { error: unknown }) {
  if (!error) return null;
  const r = lineOf(error);
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

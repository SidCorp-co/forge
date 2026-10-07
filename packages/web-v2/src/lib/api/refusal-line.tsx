"use client";

import { ApiError } from "./client";
import { formatApiError } from "./error";
import { namedRefusals, type Refusal } from "./refusals";
import { LEGEND } from "@/design";

/** A screen's own words for a refusal, from its code and facts; null leaves core's detail. */
export type RefusalWords = (r: Refusal) => string | null;

/** The first refusal core named, with how many more; a failure that named none reads as `formatApiError` words it. */
function lineOf(err: unknown, words?: RefusalWords): { code: string | null; detail: string } {
  const [first, ...rest] = namedRefusals(err);
  if (!first) return { code: err instanceof ApiError ? (err.code ?? null) : null, detail: formatApiError(err) };
  const worded = words?.(first);
  if (worded) return { code: first.code, detail: rest.length > 0 ? `${worded} (+${rest.length})` : worded };
  const at = first.path ? ` (${first.path})` : "";
  const more = rest.length > 0 ? ` · ${rest.length} more` : "";
  return { code: first.code, detail: `${first.detail}${at}${more}` };
}

/** A refusal is one tinted line: the code, then what was wrong and where — in the screen's words where it gives them. */
export function RefusalLine({ error, testid = "refusal", words }: { error: unknown; testid?: string; words?: RefusalWords }) {
  if (!error) return null;
  const r = lineOf(error, words);
  return (
    <p
      role="alert"
      className="flex min-w-0 items-baseline gap-2 px-3 py-1.5 text-12"
      style={{ color: LEGEND.err.fg, background: LEGEND.err.bg }}
      data-testid={testid}
    >
      {r.code ? <span className="shrink-0 font-mono font-semibold">{r.code}</span> : null}
      <span className="min-w-0">{r.detail}</span>
    </p>
  );
}

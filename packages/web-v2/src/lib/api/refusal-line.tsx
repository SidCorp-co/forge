"use client";

import { ApiError } from "./client";
import { formatApiError } from "./error";
import { namedRefusals, type Refusal } from "./refusals";
import { LEGEND } from "@/design";
import { readInstantsNow } from "@/lib/i18n/instants";

/** A screen's own words for a refusal, from its code and facts; null leaves core's detail. */
export type RefusalWords = (r: Refusal) => string | null;

/**
 * The first refusal core named that no field shows, with how many more; null when a field shows every
 * one. A failure that named none reads as `formatApiError` words it.
 */
function lineOf(err: unknown, words?: RefusalWords, onField?: (r: Refusal) => boolean): { code: string | null; detail: string } | null {
  const named = namedRefusals(err);
  if (named.length === 0) return { code: err instanceof ApiError ? (err.code ?? null) : null, detail: formatApiError(err) };
  const [first, ...rest] = onField ? named.filter((r) => !onField(r)) : named;
  if (!first) return null;
  const worded = words?.(first);
  if (worded) return { code: first.code, detail: readInstantsNow(rest.length > 0 ? `${worded} (+${rest.length})` : worded) };
  const at = first.path ? ` (${first.path})` : "";
  const more = rest.length > 0 ? ` · ${rest.length} more` : "";
  return { code: first.code, detail: readInstantsNow(`${first.detail}${at}${more}`) };
}

/**
 * A refusal is one tinted line: the code, then what was wrong and where — in the screen's words where
 * it gives them. A form that shows refusals on their fields (`field-refusals.ts`) passes `onField`, and
 * the line keeps only the rest.
 */
export function RefusalLine({ error, testid = "refusal", words, onField }: { error: unknown; testid?: string; words?: RefusalWords; onField?: (r: Refusal) => boolean }) {
  if (!error) return null;
  const r = lineOf(error, words, onField);
  if (!r) return null;
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

import { cache } from "react";
import { resolveServerApiBase } from "@/lib/utils/server-api-base";

/** One guide as the core registry defines it (`packages/core/src/guides/types.ts`).
 *  `body` is the guide markdown core serves. */
export interface Guide {
  slug: string;
  title: string;
  summary: string;
  version: number;
  body: string;
}

export type GuideSummary = Omit<Guide, "body">;

/** Slugs are registry keys, not paths. Anything else is refused here rather
 *  than sent on, so a crafted slug cannot reach a different core route. */
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

class GuideFetchError extends Error {
  constructor(what: string, url: string, detail: string) {
    super(`${what} (${url}): ${detail}`);
    this.name = "GuideFetchError";
  }
}

async function readJson(url: string, what: string): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, { headers: { accept: "application/json" }, next: { revalidate: 300 } });
  } catch (cause) {
    throw new GuideFetchError(what, url, `the Forge API could not be reached — ${String(cause)}`);
  }
  if (res.status === 404) return null;
  if (!res.ok) throw new GuideFetchError(what, url, `the Forge API answered ${res.status}`);
  try {
    return await res.json();
  } catch (cause) {
    throw new GuideFetchError(what, url, `the Forge API answered with no JSON — ${String(cause)}`);
  }
}

/** Every guide Forge publishes, in registry order. Throws by name when core is
 *  unreachable or answers wrongly: an empty index would read as "Forge has no
 *  guides", which is a different and false statement. */
export const fetchGuideIndex = cache(async (): Promise<GuideSummary[]> => {
  const url = `${resolveServerApiBase()}/guides`;
  const body = await readJson(url, "reading the guide index");
  const guides = (body as { guides?: unknown } | null)?.guides;
  if (!Array.isArray(guides)) {
    throw new GuideFetchError("reading the guide index", url, "the response carried no `guides` array");
  }
  return guides as GuideSummary[];
});

/** One guide, or `null` when Forge publishes no guide under that slug. */
export const fetchGuide = cache(async (slug: string): Promise<Guide | null> => {
  if (!SLUG.test(slug)) return null;
  const url = `${resolveServerApiBase()}/guides/${slug}`;
  const body = await readJson(url, `reading the guide '${slug}'`);
  if (body === null) return null;
  const guide = (body as { guide?: unknown }).guide;
  if (!guide || typeof (guide as Guide).body !== "string") {
    throw new GuideFetchError(`reading the guide '${slug}'`, url, "the response carried no `guide` body");
  }
  return guide as Guide;
});

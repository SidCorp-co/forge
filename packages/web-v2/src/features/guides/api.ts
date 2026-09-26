import { cache } from "react";
import { resolveServerApiBase } from "@/lib/utils/server-api-base";
import { GUIDE_SLUG } from "./requested-path";

/** One guide as the core registry defines it (`packages/core/src/guides/types.ts`).
 *  `body` is the guide markdown core serves. */
export interface Guide {
  slug: string;
  /** Who core says the guide is written for. Read as whatever came over the wire: `fromGuide`
   *  decides whether it is one the public documentation can place. */
  audience?: string;
  title: string;
  summary: string;
  version: number;
  body: string;
}

export type GuideSummary = Omit<Guide, "body">;

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
 *  unreachable: an empty index would read as "Forge has no guides". */
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
  // Refused here, so a crafted slug cannot reach a different core route.
  if (!GUIDE_SLUG.test(slug)) return null;
  const url = `${resolveServerApiBase()}/guides/${slug}`;
  const body = await readJson(url, `reading the guide '${slug}'`);
  if (body === null) return null;
  const guide = (body as { guide?: unknown }).guide;
  if (!guide || typeof (guide as Guide).body !== "string") {
    throw new GuideFetchError(`reading the guide '${slug}'`, url, "the response carried no `guide` body");
  }
  return guide as Guide;
});

/** Every guide with its body, in registry order — what lets the public search reach the words
 *  inside an agent guide and not only its title. A slug the index lists and core then answers 404
 *  for is refused by name: dropping it would publish a door missing a page with nothing said. */
export const fetchGuideCorpus = cache(async (): Promise<Guide[]> => {
  const index = await fetchGuideIndex();
  const guides = await Promise.all(index.map((g) => fetchGuide(g.slug)));
  const missing = index.filter((_, i) => guides[i] === null).map((g) => g.slug);
  if (missing.length > 0) {
    throw new GuideFetchError(
      "reading every guide",
      `${resolveServerApiBase()}/guides`,
      `the index lists ${missing.join(", ")} and core answers 404 for ${missing.length === 1 ? "it" : "them"}`,
    );
  }
  return guides as Guide[];
});

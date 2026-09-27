// The public documentation as one corpus: the help pages bundled into the web build, and the
// guide corpus core serves. Two homes, one list — which is what lets one search and one reader
// cover every audience. Where each page lives and why: docs/modules/guides/public-pages.md.
import type { HelpDoc } from "@/features/docs/help-content.generated";
import { groupSections, HELP_SECTION_ORDER, searchDocs } from "@/features/docs/reader";
import { coreFileUrl } from "@/lib/utils/core-url";
import type { Guide } from "./api";
import { AGENT_SECTION, AUDIENCES, type Audience, SEARCH_EXAMPLES } from "./audience";

export interface PublicDoc {
  slug: string;
  title: string;
  summary: string | null;
  audience: Audience;
  section: string;
  order: number;
  body: string;
  href: string;
  /** The same page as markdown, with no credential; only the agent corpus has one. */
  markdownUrl: string | null;
}

export const INDEX_PATH = "/guides";

export function helpPageHref(slug: string): string {
  return `${INDEX_PATH}?path=${encodeURIComponent(slug)}`;
}

export function doorHref(audience: Audience): string {
  return `${INDEX_PATH}?for=${audience}`;
}

export function guideMarkdownUrl(slug: string): string {
  return coreFileUrl(`/api/guides/${slug}.md`);
}

export function fromHelpDoc(doc: HelpDoc): PublicDoc {
  return {
    slug: doc.slug,
    title: doc.title,
    summary: null,
    audience: doc.audience,
    section: doc.section,
    order: doc.order,
    body: doc.body,
    href: helpPageHref(doc.slug),
    markdownUrl: null,
  };
}

const CORE_AUDIENCE = "agent" satisfies Audience;

/** A core guide as a public page, placed by the audience core declared for it. */
export function fromGuide(guide: Guide, order: number): PublicDoc {
  return {
    slug: guide.slug,
    title: guide.title,
    summary: guide.summary,
    audience: coreAudience(guide),
    section: AGENT_SECTION,
    order,
    body: guide.body,
    href: `${INDEX_PATH}/${guide.slug}`,
    markdownUrl: guideMarkdownUrl(guide.slug),
  };
}

function coreAudience(guide: Guide): Audience {
  // Priced amnesty, ended once live core serves the field: docs/proposals/documentation-home-residuals.md.
  if (guide.audience === undefined) {
    console.warn(
      `public docs: core served the guide '${guide.slug}' with no audience, so it is placed behind the agent door — a core older than ISS-1178; this ends when that core is redeployed`,
    );
    return CORE_AUDIENCE;
  }
  if (guide.audience !== CORE_AUDIENCE) {
    throw new Error(
      `public docs: core served the guide '${guide.slug}' with audience '${guide.audience}', and a core guide can only be placed behind the '${CORE_AUDIENCE}' door`,
    );
  }
  return CORE_AUDIENCE;
}

export function buildCorpus(helpDocs: readonly HelpDoc[], guides: readonly Guide[]): PublicDoc[] {
  return [...helpDocs.map(fromHelpDoc), ...guides.map((g, i) => fromGuide(g, i))];
}

export function docsBehind(corpus: readonly PublicDoc[], audience: Audience): PublicDoc[] {
  return corpus.filter((d) => d.audience === audience);
}

const SECTION_ORDER = [...HELP_SECTION_ORDER, AGENT_SECTION];

export function doorSections(corpus: readonly PublicDoc[], audience: Audience) {
  return groupSections(docsBehind(corpus, audience), SECTION_ORDER);
}

/** The examples whose term finds a page behind its own door. */
export function workingExamples(corpus: readonly PublicDoc[]) {
  return SEARCH_EXAMPLES.filter(({ audience, term }) =>
    (searchDocs(corpus, term) ?? []).some((d) => d.audience === audience),
  );
}

/** The search field's placeholder: one example per door, in door order. An example that no
 *  longer finds a page behind its door is left out and said so on the server log, rather than
 *  teaching a word that finds nothing. */
export function searchPlaceholder(corpus: readonly PublicDoc[]): string {
  const working = workingExamples(corpus);
  for (const dead of SEARCH_EXAMPLES.filter((e) => !working.includes(e))) {
    console.warn(
      `public docs: the search example "${dead.term}" finds no page behind the ${dead.audience} door, so the placeholder leaves it out — change SEARCH_EXAMPLES in features/guides/audience.ts`,
    );
  }
  const ordered = AUDIENCES.flatMap((a) => working.filter((e) => e.audience === a));
  if (ordered.length === 0) return "Search every page";
  return `Try ${ordered.map((e) => `“${e.term}”`).join(", ")}`;
}

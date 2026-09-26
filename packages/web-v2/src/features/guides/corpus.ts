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

/** A core guide as a public page. The registry core serves is the agent corpus — the rules
 *  agents are held to — so every guide in it is labelled `agent` here, in this one place, until
 *  core carries the field itself (ISS-1178). */
export function fromGuide(guide: Guide, order: number): PublicDoc {
  return {
    slug: guide.slug,
    title: guide.title,
    summary: guide.summary,
    audience: "agent",
    section: AGENT_SECTION,
    order,
    body: guide.body,
    href: `${INDEX_PATH}/${guide.slug}`,
    markdownUrl: guideMarkdownUrl(guide.slug),
  };
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

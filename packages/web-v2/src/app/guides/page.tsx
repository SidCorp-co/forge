import type { Metadata } from "next";
import { cache } from "react";
import { HELP_DOCS } from "@/features/docs/help-content.generated";
import { HELP_SLUGS } from "@/features/docs/help-slugs.generated";
import { fetchGuideCorpus, fetchGuideScope } from "@/features/guides/api";
import { BUNDLED_AUDIENCES, DOORS, documentTitle } from "@/features/guides/audience";
import { buildCorpus, helpPageHref, searchPlaceholder } from "@/features/guides/corpus";
import { GuideShell } from "@/features/guides/components/guide-shell";
import { PublicLanding, PublicReader, PublicRefusal } from "@/features/guides/components/public-docs";
import { GUIDES_UNAVAILABLE } from "@/features/guides/missing";
import { type PublicRequest, readPublicRequest, toSearchParams } from "@/features/guides/requested-page";
import { orUnreadable } from "@/features/guides/unreadable";

/** Per request, never prerendered: a prerender bakes the index into the image
 *  and fails the build wherever core is unreachable. */
export const dynamic = "force-dynamic";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

const DESCRIPTION =
  "Forge's documentation — for people using Forge, people connecting an AI assistant, and agents.";

/** The index every view is built from, read once per request; `null` where core's answer could not
 *  be read, and the page then says so in the docs' own shell or, for a page or door of bundled help
 *  pages, shows it from those pages alone. */
const readIndex = cache(async () => {
  const fetched = await orUnreadable(() => Promise.all([fetchGuideCorpus(), fetchGuideScope()]));
  return fetched && { corpus: buildCorpus(HELP_DOCS, fetched[0]), scope: fetched[1] };
});

/** Whether a view can be built from the bundled help pages alone, and so served while core is down. */
function bundled(asked: PublicRequest): boolean {
  return (
    asked.kind === "landing" ||
    asked.kind === "page" ||
    (asked.kind === "door" && BUNDLED_AUDIENCES.includes(asked.audience))
  );
}

export async function generateMetadata({ searchParams }: Props): Promise<Metadata> {
  const asked = readPublicRequest(toSearchParams(await searchParams), HELP_SLUGS);
  if (asked.kind !== "refused" && !bundled(asked) && !(await readIndex())) {
    return { title: documentTitle(GUIDES_UNAVAILABLE.heading), robots: { index: false } };
  }
  if (asked.kind === "door") return { title: documentTitle(DOORS[asked.audience].label), description: DESCRIPTION };
  if (asked.kind === "page") {
    const doc = HELP_DOCS.find((d) => d.slug === asked.slug);
    return { title: documentTitle(doc?.title ?? asked.slug), description: DOORS[doc?.audience ?? "user"].notice };
  }
  if (asked.kind === "refused") return { title: documentTitle(asked.refusal.heading), robots: { index: false } };
  return { title: documentTitle(null), description: DESCRIPTION };
}

export default async function GuidesPage({ searchParams }: Props) {
  const asked = readPublicRequest(toSearchParams(await searchParams), HELP_SLUGS);
  const reached = await readIndex();
  if (!reached && bundled(asked)) {
    const corpus = buildCorpus(HELP_DOCS, []);
    return (
      <GuideShell indexDown>
        {asked.kind === "landing" ? (
          <PublicLanding corpus={corpus} placeholder={searchPlaceholder(corpus, BUNDLED_AUDIENCES)} scope={null} />
        ) : (
          <PublicReader
            scope={null}
            corpus={corpus}
            view={asked.kind === "page" ? { kind: "page", href: helpPageHref(asked.slug) } : asked}
          />
        )}
      </GuideShell>
    );
  }
  if (!reached) {
    // The refusal and the bundled doors need no index; the search does, and the page says it is missing.
    return (
      <GuideShell indexDown>
        <PublicRefusal refusal={asked.kind === "refused" ? asked.refusal : GUIDES_UNAVAILABLE} />
      </GuideShell>
    );
  }
  const { corpus, scope } = reached;
  return (
    <GuideShell>
      {asked.kind === "landing" ? (
        <PublicLanding corpus={corpus} placeholder={searchPlaceholder(corpus)} scope={scope} />
      ) : (
        <PublicReader
          scope={scope}
          corpus={corpus}
          view={asked.kind === "page" ? { kind: "page", href: helpPageHref(asked.slug) } : asked}
        />
      )}
    </GuideShell>
  );
}

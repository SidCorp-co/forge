import type { Metadata } from "next";
import { HELP_DOCS } from "@/features/docs/help-content.generated";
import { HELP_SLUGS } from "@/features/docs/help-slugs.generated";
import { fetchGuideCorpus, fetchGuideScope } from "@/features/guides/api";
import { DOORS, SITE_NAME } from "@/features/guides/audience";
import { buildCorpus, helpPageHref, searchPlaceholder } from "@/features/guides/corpus";
import { GuideShell } from "@/features/guides/components/guide-shell";
import { PublicLanding, PublicReader, PublicRefusal } from "@/features/guides/components/public-docs";
import { readPublicRequest, toSearchParams } from "@/features/guides/requested-page";

/** Per request, never prerendered: a prerender bakes the index into the image
 *  and fails the build wherever core is unreachable. */
export const dynamic = "force-dynamic";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

const DESCRIPTION =
  "Forge's documentation — for people using Forge, people connecting an AI assistant, and agents.";

export async function generateMetadata({ searchParams }: Props): Promise<Metadata> {
  const asked = readPublicRequest(toSearchParams(await searchParams), HELP_SLUGS);
  if (asked.kind === "door") return { title: `${DOORS[asked.audience].label} — ${SITE_NAME}`, description: DESCRIPTION };
  if (asked.kind === "page") {
    const doc = HELP_DOCS.find((d) => d.slug === asked.slug);
    return { title: `${doc?.title ?? asked.slug} — ${SITE_NAME}`, description: DOORS[doc?.audience ?? "user"].notice };
  }
  if (asked.kind === "refused") return { title: `${asked.refusal.heading} — ${SITE_NAME}`, robots: { index: false } };
  return { title: SITE_NAME, description: DESCRIPTION };
}

export default async function GuidesPage({ searchParams }: Props) {
  const asked = readPublicRequest(toSearchParams(await searchParams), HELP_SLUGS);
  if (asked.kind === "refused") {
    // The refusal offers the docs' search, which needs the index; with core down it says so and
    // keeps the doors, rather than failing a page that names nothing of core's.
    const reached = await Promise.all([fetchGuideCorpus(), fetchGuideScope()]).then(
      ([guides, scope]) => ({ corpus: buildCorpus(HELP_DOCS, guides), scope }),
      () => null,
    );
    return (
      <GuideShell>
        {reached ? (
          <PublicReader scope={reached.scope} corpus={reached.corpus} view={asked} />
        ) : (
          <PublicRefusal refusal={asked.refusal} />
        )}
      </GuideShell>
    );
  }
  const [guides, scope] = await Promise.all([fetchGuideCorpus(), fetchGuideScope()]);
  const corpus = buildCorpus(HELP_DOCS, guides);
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

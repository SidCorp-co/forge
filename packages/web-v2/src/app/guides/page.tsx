import type { Metadata } from "next";
import { HELP_DOCS } from "@/features/docs/help-content.generated";
import { HELP_SLUGS } from "@/features/docs/help-slugs.generated";
import { fetchGuideCorpus } from "@/features/guides/api";
import { DOORS } from "@/features/guides/audience";
import { buildCorpus, helpPageHref, searchPlaceholder } from "@/features/guides/corpus";
import { GuideShell } from "@/features/guides/components/guide-shell";
import { PublicLanding, PublicReader } from "@/features/guides/components/public-docs";
import { readPublicRequest, toSearchParams } from "@/features/guides/requested-page";

/** Per request, never prerendered: a prerender bakes the index into the image
 *  and fails the build wherever core is unreachable. */
export const dynamic = "force-dynamic";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

const SITE = "Forge documentation";
const DESCRIPTION =
  "Forge's documentation — for people using Forge, people connecting an AI assistant, and agents.";

export async function generateMetadata({ searchParams }: Props): Promise<Metadata> {
  const asked = readPublicRequest(toSearchParams(await searchParams), HELP_SLUGS);
  if (asked.kind === "door") return { title: `${DOORS[asked.audience].label} — ${SITE}`, description: DESCRIPTION };
  if (asked.kind === "page") {
    const doc = HELP_DOCS.find((d) => d.slug === asked.slug);
    return { title: `${doc?.title ?? asked.slug} — ${SITE}`, description: DOORS[doc?.audience ?? "user"].notice };
  }
  if (asked.kind === "refused") return { title: `${asked.refusal.heading} — ${SITE}`, robots: { index: false } };
  return { title: SITE, description: DESCRIPTION };
}

export default async function GuidesPage({ searchParams }: Props) {
  const asked = readPublicRequest(toSearchParams(await searchParams), HELP_SLUGS);
  const corpus = buildCorpus(HELP_DOCS, await fetchGuideCorpus());
  const placeholder = searchPlaceholder(corpus);
  return (
    <GuideShell>
      {asked.kind === "landing" ? (
        <PublicLanding corpus={corpus} placeholder={placeholder} />
      ) : (
        <PublicReader
          corpus={corpus}
          view={asked.kind === "page" ? { kind: "page", href: helpPageHref(asked.slug) } : asked}
        />
      )}
    </GuideShell>
  );
}

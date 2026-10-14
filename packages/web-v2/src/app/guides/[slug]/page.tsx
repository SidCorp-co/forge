import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { cache } from "react";
import { HELP_DOCS } from "@/features/docs/help-content.generated";
import { fetchGuide, fetchGuideCorpus, fetchGuideScope } from "@/features/guides/api";
import { DOORS, documentTitle } from "@/features/guides/audience";
import { buildCorpus, fromGuide } from "@/features/guides/corpus";
import { GuideShell } from "@/features/guides/components/guide-shell";
import { PublicReader, PublicRefusal } from "@/features/guides/components/public-docs";
import { GUIDES_UNAVAILABLE } from "@/features/guides/missing";
import { orUnreadable } from "@/features/guides/unreadable";

type Params = { params: Promise<{ slug: string }> };

/** The guide and the corpus its reader is built from, read once per request; `null` where core's
 *  answer could not be read. */
const readGuide = cache((slug: string) =>
  orUnreadable(async () => {
    const guide = await fetchGuide(slug);
    if (!guide) return { guide: null };
    const [guides, scope] = await Promise.all([fetchGuideCorpus(), fetchGuideScope()]);
    return { guide, corpus: buildCorpus(HELP_DOCS, guides), scope };
  }),
);

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const read = await readGuide((await params).slug);
  if (!read) return { title: documentTitle(GUIDES_UNAVAILABLE.heading), robots: { index: false } };
  const { guide } = read;
  if (!guide) return {};
  return { title: documentTitle(guide.title), description: `${DOORS.agent.notice} ${guide.summary}` };
}

export default async function GuidePage({ params }: Params) {
  const read = await readGuide((await params).slug);
  if (!read) {
    return (
      <GuideShell>
        <PublicRefusal refusal={GUIDES_UNAVAILABLE} />
      </GuideShell>
    );
  }
  if (!read.guide) notFound();
  return (
    <GuideShell>
      <PublicReader
        scope={read.scope}
        corpus={read.corpus}
        view={{ kind: "page", href: fromGuide(read.guide, 0).href }}
      />
    </GuideShell>
  );
}

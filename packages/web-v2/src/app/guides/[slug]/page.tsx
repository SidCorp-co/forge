import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { HELP_DOCS } from "@/features/docs/help-content.generated";
import { fetchGuide, fetchGuideCorpus } from "@/features/guides/api";
import { DOORS } from "@/features/guides/audience";
import { buildCorpus, fromGuide } from "@/features/guides/corpus";
import { GuideShell } from "@/features/guides/components/guide-shell";
import { PublicReader } from "@/features/guides/components/public-docs";

type Params = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { slug } = await params;
  const guide = await fetchGuide(slug);
  if (!guide) return {};
  return { title: `${guide.title} — Forge documentation`, description: `${DOORS.agent.notice} ${guide.summary}` };
}

export default async function GuidePage({ params }: Params) {
  const { slug } = await params;
  const guide = await fetchGuide(slug);
  if (!guide) notFound();
  const corpus = buildCorpus(HELP_DOCS, await fetchGuideCorpus());
  return (
    <GuideShell>
      <PublicReader
        corpus={corpus}
        view={{ kind: "page", href: fromGuide(guide, 0).href }}
      />
    </GuideShell>
  );
}

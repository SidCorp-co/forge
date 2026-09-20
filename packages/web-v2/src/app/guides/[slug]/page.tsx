import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Markdown } from "@/design";
import { fetchGuide } from "@/features/guides/api";
import { GuideShell } from "@/features/guides/components/guide-shell";

type Params = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { slug } = await params;
  const guide = await fetchGuide(slug);
  if (!guide) return {};
  return { title: `${guide.title} — Forge guides`, description: guide.summary };
}

export default async function GuidePage({ params }: Params) {
  const { slug } = await params;
  // `fetchGuide` is `cache`d, so this reuses generateMetadata's lookup.
  const guide = await fetchGuide(slug);
  if (!guide) notFound();
  return (
    <GuideShell back>
      <h1 className="fg-h2 text-fg">{guide.title}</h1>
      <p className="fg-body-sm mt-1.5 mb-7 text-muted">{guide.summary}</p>
      <Markdown variant="prose">{guide.body}</Markdown>
    </GuideShell>
  );
}

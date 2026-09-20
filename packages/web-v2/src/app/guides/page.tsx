import Link from "next/link";
import type { Metadata } from "next";
import { PageTitle } from "@/design";
import { fetchGuideIndex } from "@/features/guides/api";
import { GuideShell } from "@/features/guides/components/guide-shell";

/** Per request, never prerendered: a prerender bakes the index into the image
 *  and fails the build wherever core is unreachable. */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Forge guides",
  description: "Every guide Forge publishes — the conventions its agents are held to.",
};

export default async function GuidesIndexPage() {
  const guides = await fetchGuideIndex();
  return (
    <GuideShell>
      <PageTitle className="fg-h2 mb-6 text-fg">Forge guides</PageTitle>
      <ul className="flex flex-col gap-1">
        {guides.map((guide) => (
          <li key={guide.slug}>
            <Link
              href={`/guides/${guide.slug}`}
              className="-mx-3 block rounded-md px-3 py-3 hover:bg-hover"
            >
              <span className="fg-body block font-semibold text-fg">{guide.title}</span>
              <span className="fg-body-sm mt-0.5 block text-muted">{guide.summary}</span>
            </Link>
          </li>
        ))}
      </ul>
    </GuideShell>
  );
}

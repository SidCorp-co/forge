import { createFileRoute } from "@tanstack/react-router";
import { HELP_DOCS } from "@/features/docs/help-content.generated";
import { fetchGuide, fetchGuideCorpus } from "@/features/guides/api";
import { DOORS } from "@/features/guides/audience";
import { buildCorpus, fromGuide } from "@/features/guides/corpus";
import { GuideShell } from "@/features/guides/components/guide-shell";
import { PublicReader } from "@/features/guides/components/public-docs";
import { GuideNotFound } from "./-not-found";

// A plain request for a slug core does not publish is answered by core with a 404 document before
// the web loads; a navigation inside the web to one lands here with no guide and says the same words.
function GuidePage() {
  const { guide, guides } = Route.useLoaderData();
  if (!guide) return <GuideNotFound />;
  return (
    <GuideShell>
      <PublicReader corpus={buildCorpus(HELP_DOCS, guides)} view={{ kind: "page", href: fromGuide(guide, 0).href }} />
    </GuideShell>
  );
}

export const Route = createFileRoute("/guides/$slug/")({
  loader: async ({ params }) => {
    const [guide, guides] = await Promise.all([fetchGuide(params.slug), fetchGuideCorpus()]);
    return { guide, guides };
  },
  head: ({ loaderData }) =>
    loaderData?.guide
      ? {
          meta: [
            { title: `${loaderData.guide.title} — Forge documentation` },
            { name: "description", content: `${DOORS.agent.notice} ${loaderData.guide.summary}` },
          ],
        }
      : { meta: [{ name: "robots", content: "noindex" }] },
  component: GuidePage,
});

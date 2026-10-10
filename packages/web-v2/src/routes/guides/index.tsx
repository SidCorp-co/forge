import { createFileRoute } from "@tanstack/react-router";
import { HELP_DOCS } from "@/features/docs/help-content.generated";
import { HELP_SLUGS } from "@/features/docs/help-slugs.generated";
import { fetchGuideCorpus } from "@/features/guides/api";
import { DOORS } from "@/features/guides/audience";
import { buildCorpus, helpPageHref, searchPlaceholder } from "@/features/guides/corpus";
import { GuideShell } from "@/features/guides/components/guide-shell";
import { PublicLanding, PublicReader, PublicRefusal } from "@/features/guides/components/public-docs";
import { readPublicRequest } from "@/features/guides/requested-page";
import { useSearchParams } from "@/lib/navigation/router";

const SITE = "Forge documentation";
const DESCRIPTION = "Forge's documentation — for people using Forge and for agents.";

function askedOf(search: unknown) {
  return readPublicRequest(new URLSearchParams(search as Record<string, string>), HELP_SLUGS);
}

function titleOf(search: unknown): { title: string; description?: string } {
  const asked = askedOf(search);
  if (asked.kind === "door") return { title: `${DOORS[asked.audience].label} — ${SITE}`, description: DESCRIPTION };
  if (asked.kind === "page") {
    const doc = HELP_DOCS.find((d) => d.slug === asked.slug);
    return { title: `${doc?.title ?? asked.slug} — ${SITE}`, description: DOORS[doc?.audience ?? "user"].notice };
  }
  if (asked.kind === "refused") return { title: `${asked.refusal.heading} — ${SITE}` };
  return { title: SITE, description: DESCRIPTION };
}

function GuidesPage() {
  const asked = readPublicRequest(useSearchParams(), HELP_SLUGS);
  const guides = Route.useLoaderData();
  if (asked.kind === "refused") {
    return (
      <GuideShell>
        <PublicRefusal refusal={asked.refusal} />
      </GuideShell>
    );
  }
  const corpus = buildCorpus(HELP_DOCS, guides);
  return (
    <GuideShell>
      {asked.kind === "landing" ? (
        <PublicLanding corpus={corpus} placeholder={searchPlaceholder(corpus)} />
      ) : (
        <PublicReader
          corpus={corpus}
          view={asked.kind === "page" ? { kind: "page", href: helpPageHref(asked.slug) } : asked}
        />
      )}
    </GuideShell>
  );
}

export const Route = createFileRoute("/guides/")({
  loader: () => fetchGuideCorpus(),
  head: ({ match }) => {
    const { title, description } = titleOf(match.search);
    return { meta: [{ title }, ...(description ? [{ name: "description", content: description }] : [])] };
  },
  component: GuidesPage,
});

"use client";

// Forge end-user docs (`/docs`). Content is authored in
// `packages/web-v2/content/help/*.md` and bundled at build time into
// `help-content.generated.ts` (see scripts/gen-help-content.mjs) — no backend,
// no filesystem read, no API. Internal engineering docs (repo `docs/`) are NOT
// here and are never served to users.
import { useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  Card,
  CardContent,
  EmptyState,
  HelpButton,
  PageContainer,
  PageTitle,
} from "@/design";
import { HELP_DOCS } from "../help-content.generated";
import { deriveToc, groupSections, HELP_SECTION_ORDER, searchDocs } from "../reader";
import { DocsArticle, DocsLayout, type DocsNavItem, DocsSidebar } from "./docs-reader";

export function DocsScreen() {
  const searchParams = useSearchParams();
  const sections = useMemo(() => groupSections(HELP_DOCS, HELP_SECTION_ORDER), []);
  const firstSlug = sections[0]?.docs[0]?.slug ?? null;

  // `?path=<slug>` deep-link (e.g. from a HelpButton "Learn more"). One naming no page is said
  // to name none, rather than answered with the first page as if it had been asked for.
  const deepLink = searchParams.get("path");
  const missing = deepLink !== null && !HELP_DOCS.some((d) => d.slug === deepLink) ? deepLink : null;
  const [selected, setSelected] = useState<string | null>(
    deepLink !== null ? (missing === null ? deepLink : null) : firstSlug,
  );
  const [query, setQuery] = useState("");

  const doc = useMemo(() => HELP_DOCS.find((d) => d.slug === selected) ?? null, [selected]);
  const toc = useMemo(() => (doc ? deriveToc(doc.body) : []), [doc]);

  const item = (d: (typeof HELP_DOCS)[number]): DocsNavItem => ({
    key: d.slug,
    title: d.title,
    active: selected === d.slug,
    onSelect: () => setSelected(d.slug),
  });
  const results = useMemo(() => searchDocs(HELP_DOCS, query), [query]);

  return (
    <PageContainer className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <PageTitle className="fg-h2">Docs</PageTitle>
        <HelpButton
          summary="How to use Forge — getting started, pairing a runner, managing your organization, connecting your own assistant, and troubleshooting. Pick a page from the left, read it in the center, and jump around with the table of contents."
          actions={["Search filters the page list", "Click a TOC entry to jump to that heading"]}
        />
      </div>

      {HELP_DOCS.length === 0 ? (
        <Card>
          <CardContent>
            <EmptyState title="No docs" message="No help pages are available." mascot={false} />
          </CardContent>
        </Card>
      ) : (
        <DocsLayout
          toc={toc}
          sidebar={
            <DocsSidebar
              query={query}
              onQuery={setQuery}
              placeholder="Search docs"
              searchLabel="Search docs"
              results={results ? results.map(item) : null}
              sections={sections.map((s) => ({ name: s.name, items: s.docs.map(item) }))}
              navLabel="Docs"
            />
          }
        >
          {!doc ? (
            <EmptyState
              title={missing === null ? "Select a page" : "No such help page"}
              message={
                missing === null
                  ? "Pick a page from the left to start reading."
                  : missing === ""
                    ? "The link you followed names no help page. Pick one from the left."
                    : `No help page is called "${missing}". Pick one from the left.`
              }
              mascot={false}
            />
          ) : (
            <DocsArticle body={doc.body} docBasePath={doc.slug} />
          )}
        </DocsLayout>
      )}
    </PageContainer>
  );
}

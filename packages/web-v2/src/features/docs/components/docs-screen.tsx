// Forge end-user docs (`/docs`). Content is authored in
// `packages/web-v2/content/help/*.md` and bundled at build time into
// `help-content.generated.ts` (see scripts/gen-help-content.mjs) — no backend,
// no filesystem read, no API. Internal engineering docs (repo `docs/`) are NOT
// here and are never served to users.
//
// The face is the list of page titles and a search (REQ-11 BC-18, ISS-903): a page opens on a click
// in a side drawer, never as a column beside the list, and `?path=<slug>` opens it from a link.
import { useMemo, useState } from "react";
import {
  DetailDrawer,
  EmptyState,
  PageContainer,
  PageTitle,
  useUrlParams,
} from "@/design";
import { HELP_DOCS } from "../help-content.generated";
import { groupSections, HELP_SECTION_ORDER, searchDocs } from "../reader";
import { DocsArticle, type DocsNavItem, DocsSidebar } from "./docs-reader";

export function DocsScreen() {
  const [params, setParams] = useUrlParams();
  const sections = useMemo(
    () => groupSections(HELP_DOCS, HELP_SECTION_ORDER),
    [],
  );
  const [query, setQuery] = useState("");
  const results = useMemo(() => searchDocs(HELP_DOCS, query), [query]);

  // `?path=<slug>` deep-link (e.g. from a HelpButton "Learn more"). One naming no page is said
  // to name none, never answered with another page as if it had been asked for.
  const selected = params.get("path");
  const doc =
    selected === null
      ? null
      : (HELP_DOCS.find((d) => d.slug === selected) ?? null);
  const missing = selected !== null && doc === null ? selected : null;

  const item = (d: (typeof HELP_DOCS)[number]): DocsNavItem => ({
    key: d.slug,
    title: d.title,
    active: selected === d.slug,
    onSelect: () => setParams({ path: d.slug }),
  });

  return (
    <PageContainer>
      <PageTitle>Docs</PageTitle>
      <div className="flex max-w-xl flex-col gap-4">
        {missing !== null ? (
          <EmptyState
            title="No such help page"
            message={
              missing === ""
                ? "The link names no page."
                : `No page "${missing}".`
            }
            mascot={false}
          />
        ) : null}
        {HELP_DOCS.length === 0 ? (
          <EmptyState
            title="No docs"
            message="No help pages yet."
            mascot={false}
          />
        ) : (
          <DocsSidebar
            query={query}
            onQuery={setQuery}
            placeholder="Search docs"
            searchLabel="Search docs"
            results={results ? results.map(item) : null}
            sections={sections.map((s) => ({
              name: s.name,
              items: s.docs.map(item),
            }))}
            navLabel="Docs"
          />
        )}
      </div>
      <DetailDrawer
        label="Docs"
        title={doc?.title}
        trigger={false}
        width={760}
        open={doc !== null}
        onOpenChange={(open) => !open && setParams({ path: null })}
      >
        {doc ? <DocsArticle body={doc.body} docBasePath={doc.slug} /> : null}
      </DetailDrawer>
    </PageContainer>
  );
}

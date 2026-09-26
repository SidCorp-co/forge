"use client";

// The public documentation at `/guides`: a landing with the three doors and a search over every
// page, and a reader built from the same furniture as the in-app `/docs` screen.
import Link from "next/link";
import { useMemo, useState } from "react";
import { EmptyState, PageTitle } from "@/design";
import { LINK_CLASS } from "@/design/patterns/body-tags";
import {
  DocsArticle,
  DocsLayout,
  type DocsNavItem,
  DocsSearchField,
  DocsSearchResults,
  DocsSidebar,
} from "@/features/docs/components/docs-reader";
import { deriveToc, searchDocs } from "@/features/docs/reader";
import { coreFileUrl } from "@/lib/utils/core-url";
import { AUDIENCES, type Audience, DOORS, ONE_CORPUS } from "../audience";
import {
  INDEX_PATH,
  type PublicDoc,
  docsBehind,
  doorHref,
  doorSections,
} from "../corpus";
import type { Refusal } from "../missing";

/** What the reader shows: a door's page list, one page (by its href, which is unique across
 *  both homes), or a refusal of the address. */
export type ReaderView =
  | { kind: "door"; audience: Audience }
  | { kind: "page"; href: string }
  | { kind: "refused"; refusal: Refusal };

function resultItem(doc: PublicDoc, activeHref: string | null): DocsNavItem {
  return {
    key: doc.href,
    title: doc.title,
    active: doc.href === activeHref,
    href: doc.href,
    tag: DOORS[doc.audience].label,
  };
}

function useSearch(corpus: readonly PublicDoc[]) {
  const [query, setQuery] = useState("");
  const results = useMemo(() => searchDocs(corpus, query), [corpus, query]);
  return { query, setQuery, results };
}

export function PublicLanding({
  corpus,
  placeholder,
}: {
  corpus: readonly PublicDoc[];
  placeholder: string;
}) {
  const { query, setQuery, results } = useSearch(corpus);
  return (
    <div className="flex flex-col gap-6">
      <div>
        <PageTitle className="fg-h2 text-fg">Forge documentation</PageTitle>
        <p className="fg-body mt-2 max-w-[72ch] text-muted">{ONE_CORPUS}</p>
      </div>
      <div className="max-w-[72ch]">
        <DocsSearchField
          query={query}
          onQuery={setQuery}
          placeholder={placeholder}
          label="Search every page"
        />
        {results ? <DocsSearchResults results={results.map((d) => resultItem(d, null))} /> : null}
      </div>
      <nav aria-label="Ways in" className="grid grid-cols-1 gap-3 md:grid-cols-3">
        {AUDIENCES.map((audience) => {
          const count = docsBehind(corpus, audience).length;
          return (
            <Link
              key={audience}
              href={doorHref(audience)}
              className="flex flex-col gap-1.5 rounded-lg border border-line bg-surface p-5 shadow-sm hover:bg-hover"
            >
              <span className="fg-h3 text-fg">{DOORS[audience].label}</span>
              <span className="fg-body-sm text-muted">{DOORS[audience].blurb}</span>
              <span className="fg-caption mt-auto pt-2 text-subtle">
                {count} {count === 1 ? "page" : "pages"}
              </span>
            </Link>
          );
        })}
      </nav>
    </div>
  );
}

/** The addresses the agent door documents — every one of them already served by core. */
function MachineDoor({ docs }: { docs: readonly PublicDoc[] }) {
  return (
    <section aria-label="Plain markdown" className="mb-6 flex flex-col gap-2">
      <p className="fg-body text-fg">
        Every page behind this door is also plain markdown, with no credential and no session: the
        same text this page shows, at <code className="break-all font-mono">{coreFileUrl("/api/guides")}/&lt;slug&gt;.md</code>.
      </p>
      <p className="fg-body-sm text-muted">
        The index is <code className="break-all font-mono">{coreFileUrl("/api/guides")}</code> as JSON, and{" "}
        <code className="break-all font-mono">{coreFileUrl("/api/llms.txt")}</code> lists every page for a
        model to fetch. There are {docs.length} pages.
      </p>
    </section>
  );
}

function DoorPage({ audience, docs }: { audience: Audience; docs: readonly PublicDoc[] }) {
  return (
    <div style={{ maxWidth: "72ch" }} className="mx-auto">
      <PageTitle className="fg-h2 text-fg">{DOORS[audience].label}</PageTitle>
      <p className="fg-body-sm mt-1.5 mb-6 text-muted">{DOORS[audience].blurb}</p>
      {audience === "agent" ? <MachineDoor docs={docs} /> : null}
      <ul aria-label="Pages" className="flex flex-col gap-1">
        {docs.map((doc) => (
          <li key={doc.href}>
            <Link href={doc.href} className="-mx-3 block rounded-md px-3 py-2.5 hover:bg-hover">
              <span className="fg-body block font-semibold text-fg">{doc.title}</span>
              <span className="fg-body-sm mt-0.5 block text-muted">{doc.summary ?? doc.section}</span>
              {doc.markdownUrl ? (
                <code className="fg-caption mt-0.5 block break-all font-mono text-subtle">{doc.markdownUrl}</code>
              ) : null}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Said above every page: who it was written for, and for an agent page where its markdown is. */
function AudienceNotice({ doc }: { doc: PublicDoc }) {
  return (
    <aside
      aria-label="Written for"
      className="fg-body-sm mb-6 rounded-md border border-line bg-sunken px-4 py-3 text-muted"
    >
      <p className="text-fg">{DOORS[doc.audience].notice}</p>
      {doc.summary ? <p className="mt-1">{doc.summary}</p> : null}
      {doc.markdownUrl ? (
        <p className="mt-1">
          The same text as markdown:{" "}
          <a href={doc.markdownUrl} className={LINK_CLASS}>
            <code className="break-all font-mono">{doc.markdownUrl}</code>
          </a>
        </p>
      ) : null}
    </aside>
  );
}

/** The sidebar's field is 260px wide, where the landing's teaching placeholder is cut off after
 *  its first word; the examples are taught on the landing, whose field has the width for them. */
const SIDEBAR_PLACEHOLDER = "Search every page";

export function PublicReader({ corpus, view }: { corpus: readonly PublicDoc[]; view: ReaderView }) {
  const { query, setQuery, results } = useSearch(corpus);
  const doc = view.kind === "page" ? (corpus.find((d) => d.href === view.href) ?? null) : null;
  const audience: Audience | null =
    view.kind === "door" ? view.audience : doc ? doc.audience : null;
  const toc = useMemo(() => (doc ? deriveToc(doc.body) : []), [doc]);
  const activeHref = doc?.href ?? null;

  const sections = audience
    ? doorSections(corpus, audience).map((s) => ({
        name: s.name,
        items: s.docs.map((d) => ({ key: d.href, title: d.title, active: d.href === activeHref, href: d.href })),
      }))
    : [];

  const otherDoors = AUDIENCES.filter((a) => a !== audience);
  const sidebar = (
    <DocsSidebar
      query={query}
      onQuery={setQuery}
      placeholder={SIDEBAR_PLACEHOLDER}
      searchLabel="Search every page"
      results={results ? results.map((d) => resultItem(d, activeHref)) : null}
      sections={sections}
      navLabel={audience ? DOORS[audience].label : "Documentation"}
      footer={
        <nav aria-label="Other ways in" className="mt-2 flex flex-col gap-0.5 border-t border-line-subtle pt-3">
          <span className="fg-overline px-2 py-1 font-mono text-subtle">
            {audience ? "Other ways in" : "Ways in"}
          </span>
          {otherDoors.map((a) => (
            <Link key={a} href={doorHref(a)} className="rounded-md px-2 py-1 text-13 text-muted hover:bg-hover hover:text-fg">
              {DOORS[a].label}
            </Link>
          ))}
          <Link href={INDEX_PATH} className="rounded-md px-2 py-1 text-13 text-muted hover:bg-hover hover:text-fg">
            All three ways in
          </Link>
        </nav>
      }
    />
  );

  let content: React.ReactNode;
  if (view.kind === "refused") {
    content = <EmptyState title={view.refusal.heading} message={view.refusal.body} mascot={false} />;
  } else if (view.kind === "door") {
    content = <DoorPage audience={view.audience} docs={docsBehind(corpus, view.audience)} />;
  } else if (!doc) {
    // The server resolved this href from the same corpus, so a miss here is a defect, said so.
    content = (
      <EmptyState title="This page is missing from the documentation it was resolved against" message={view.href} mascot={false} />
    );
  } else {
    const crumbs =
      doc.audience === "agent"
        ? [DOORS[doc.audience].label, doc.title]
        : [DOORS[doc.audience].label, doc.section, doc.title];
    content = (
      <DocsArticle
        crumbs={crumbs}
        body={doc.body}
        docBasePath={doc.audience === "agent" ? undefined : doc.slug}
        docRoute={INDEX_PATH}
      >
        <AudienceNotice doc={doc} />
      </DocsArticle>
    );
  }

  return (
    <DocsLayout sidebar={sidebar} toc={toc} contentFirst>
      {content}
    </DocsLayout>
  );
}

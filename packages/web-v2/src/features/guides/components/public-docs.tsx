"use client";

// The public documentation at `/guides`: a landing with the three doors and a search over every
// page, and a reader built from the same furniture as the in-app `/docs` screen.
import Link from "next/link";
import { Fragment, useEffect, useMemo, useState } from "react";
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
import { deriveToc, matchExcerpt, searchDocs } from "@/features/docs/reader";
import { coreFileUrl } from "@/lib/utils/core-url";
import type { GuideScope } from "../api";
import { AUDIENCES, type Audience, DOORS, doorHref, documentTitle, INDEX_PATH, ONE_CORPUS } from "../audience";
import { type PublicDoc, docsBehind, doorSections } from "../corpus";
import { ALL_DOORS_LINK_TEXT, type Refusal, SEARCH_UNAVAILABLE } from "../missing";

/** What the reader shows: a door's page list, or one page by its href, unique across both homes. */
export type ReaderView =
  | { kind: "door"; audience: Audience }
  | { kind: "page"; href: string }
  | { kind: "refused"; refusal: Refusal };

function resultItem(doc: PublicDoc, activeHref: string | null, query: string): DocsNavItem {
  return {
    key: doc.href,
    title: doc.title,
    active: doc.href === activeHref,
    href: doc.href,
    tag: DOORS[doc.audience].label,
    found: { query, excerpt: matchExcerpt(doc, query) },
  };
}

/** The tab's title, set on every render: a client-side navigation between `/guides` addresses that
 *  differ only in their query keeps the head of the first one — docs/modules/guides/public-pages.md. */
function useDocumentTitle(subject: string | null) {
  const title = documentTitle(subject);
  useEffect(() => {
    document.title = title;
  }, [title]);
}

/** What the tab names for a reader's view: the door, the page, or the refusal it shows. */
function viewSubject(view: ReaderView, doc: PublicDoc | null): string {
  if (view.kind === "door") return DOORS[view.audience].label;
  if (view.kind === "refused") return view.refusal.heading;
  return doc?.title ?? view.href;
}

/** Core's own words, with each backticked span set as code; nothing here restates what core says. */
function Said({ text }: { text: string }) {
  let offset = 0;
  const parts = text.split("`").map((part, i) => {
    const key = offset;
    offset += part.length + 1;
    return i % 2 === 1 ? (
      <code key={key} className="font-mono">
        {part}
      </code>
    ) : (
      <Fragment key={key}>{part}</Fragment>
    );
  });
  return <>{parts}</>;
}

function useSearch(corpus: readonly PublicDoc[]) {
  const [query, setQuery] = useState("");
  const results = useMemo(() => searchDocs(corpus, query), [corpus, query]);
  return { query, setQuery, results };
}

export function PublicLanding({
  corpus,
  placeholder,
  scope,
}: {
  corpus: readonly PublicDoc[];
  placeholder: string;
  scope: GuideScope;
}) {
  const { query, setQuery, results } = useSearch(corpus);
  useDocumentTitle(null);
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
        {results ? <DocsSearchResults results={results.map((d) => resultItem(d, null, query))} /> : null}
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
              {audience === "agent" ? (
                <span className="fg-caption text-subtle">
                  <Said text={scope.elsewhere} />
                </span>
              ) : null}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}

/** The addresses the agent door documents — every one of them already served by core. */
function MachineDoor({ docs, scope }: { docs: readonly PublicDoc[]; scope: GuideScope }) {
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
      <p className="fg-body-sm text-muted">
        <Said text={`${scope.elsewhere} ${scope.reach}`} />
      </p>
    </section>
  );
}

function DoorPage({
  audience,
  docs,
  scope,
}: {
  audience: Audience;
  docs: readonly PublicDoc[];
  scope: GuideScope;
}) {
  return (
    <div style={{ maxWidth: "72ch" }} className="mx-auto">
      <div className="flex items-start justify-between gap-4">
        <PageTitle className="fg-h2 text-fg">{DOORS[audience].label}</PageTitle>
        <JumpToSearch />
      </div>
      <p className="fg-body-sm mt-1.5 mb-6 text-muted">{DOORS[audience].blurb}</p>
      {audience === "agent" ? <MachineDoor docs={docs} scope={scope} /> : null}
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

const SEARCH_FIELD_ID = "docs-search";

/** Below `lg` the sidebar, and the search field in it, sits after the page, so this takes the reader
 *  to the field and focuses it. From `lg` up the sidebar is beside the page and this is not shown. */
function JumpToSearch() {
  return (
    <a
      href={`#${SEARCH_FIELD_ID}`}
      onClick={(e) => {
        const field = document.getElementById(SEARCH_FIELD_ID);
        if (!field) return;
        e.preventDefault();
        field.focus();
      }}
      className="fg-caption flex-none text-muted underline underline-offset-2 hover:text-fg lg:hidden"
    >
      Search
    </a>
  );
}

/** The sidebar's field is 260px wide, where the landing's teaching placeholder is cut off after
 *  its first word; the examples are taught on the landing, whose field has the width for them. */
const SIDEBAR_PLACEHOLDER = "Search every page";

export function PublicReader({
  corpus,
  view,
  scope,
}: {
  corpus: readonly PublicDoc[];
  view: ReaderView;
  scope: GuideScope;
}) {
  const { query, setQuery, results } = useSearch(corpus);
  const doc = view.kind === "page" ? (corpus.find((d) => d.href === view.href) ?? null) : null;
  useDocumentTitle(viewSubject(view, doc));
  // A refusal names no door, so its sidebar is the search and every door as the way on.
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
      searchId={SEARCH_FIELD_ID}
      results={results ? results.map((d) => resultItem(d, activeHref, query)) : null}
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
  if (view.kind === "door") {
    const docs = doorSections(corpus, view.audience).flatMap((section) => section.docs);
    content = <DoorPage audience={view.audience} docs={docs} scope={scope} />;
  } else if (view.kind === "refused") {
    content = <RefusalCopy refusal={view.refusal} />;
  } else if (!doc) {
    // The server resolved this href from the same corpus, so a miss here is a defect, said so.
    content = (
      <EmptyState title="This page is missing from the documentation it was resolved against" message={view.href} mascot={false} />
    );
  } else {
    const door = { label: DOORS[doc.audience].label, href: doorHref(doc.audience) };
    const crumbs = doc.audience === "agent" ? [door, doc.title] : [door, doc.section, doc.title];
    content = (
      <DocsArticle
        crumbs={crumbs}
        body={doc.body}
        docBasePath={doc.audience === "agent" ? undefined : doc.slug}
        docRoute={INDEX_PATH}
        trailing={<JumpToSearch />}
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

function RefusalCopy({ refusal }: { refusal: Refusal }) {
  return (
    <div className="flex max-w-[72ch] flex-col gap-2">
      <PageTitle className="fg-h2 text-fg">{refusal.heading}</PageTitle>
      <p className="fg-body-sm text-muted">{refusal.body}</p>
      <div>
        <JumpToSearch />
      </div>
    </div>
  );
}

/** An address naming no page or door, when the guide index could not be reached to search: every
 *  door as the way on, and the reason there is no search said rather than left out. With the index
 *  in hand a refusal is a `PublicReader` view, which offers the search. */
export function PublicRefusal({ refusal }: { refusal: Refusal }) {
  useDocumentTitle(refusal.heading);
  return (
    <div className="mx-auto flex max-w-[72ch] flex-col gap-4 py-8">
      <PageTitle className="fg-h2 text-fg">{refusal.heading}</PageTitle>
      <p className="fg-body-sm text-muted">{refusal.body}</p>
      <p className="fg-body-sm text-muted">{SEARCH_UNAVAILABLE}</p>
      <nav aria-label="Ways in" className="flex flex-col gap-1">
        {AUDIENCES.map((a) => (
          <Link key={a} href={doorHref(a)} className={LINK_CLASS}>
            {DOORS[a].label}
          </Link>
        ))}
        <Link href={INDEX_PATH} className={LINK_CLASS}>
          {ALL_DOORS_LINK_TEXT}
        </Link>
      </nav>
    </div>
  );
}

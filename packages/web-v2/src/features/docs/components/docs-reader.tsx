"use client";

// The documentation reader's furniture — the three-column grid, the sidebar with its search
// field and grouped page list, the article, the table of contents. The in-app `/docs` screen
// and the public `/guides` pages both compose these, so there is one reading UI, not two.
import Link from "next/link";
import { type ReactNode, useEffect, useRef } from "react";
import { Card, CardContent, Icon, Input, Markdown } from "@/design";
import { cn } from "@/lib/utils/cn";
import { slugify } from "../reader";
import type { TocEntry } from "../types";

/** One entry in the sidebar: a button where the reader selects in place, a link where each
 *  page has its own address. */
export interface DocsNavItem {
  key: string;
  title: string;
  active: boolean;
  href?: string;
  onSelect?: () => void;
  /** A short label beside the title, e.g. which door a search result sits behind. */
  tag?: string;
}

export interface DocsNavSection {
  name: string;
  items: DocsNavItem[];
}

function itemClass(active: boolean) {
  return active
    ? "flex w-full items-center gap-1.5 rounded-md bg-hover px-2 py-1 text-left text-13 font-semibold text-fg"
    : "flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-13 text-muted hover:bg-hover hover:text-fg";
}

function ItemBody({ item }: { item: DocsNavItem }) {
  return (
    <>
      <Icon name="book" size={13} className="flex-none self-start pt-0.5 text-subtle" />
      {item.tag ? (
        <span className="flex min-w-0 flex-col">
          <span className="truncate">{item.title}</span>
          <span className="fg-caption text-subtle">{item.tag}</span>
        </span>
      ) : (
        <span className="truncate">{item.title}</span>
      )}
    </>
  );
}

export function DocsNavEntry({ item }: { item: DocsNavItem }) {
  const current = item.active ? "page" : undefined;
  if (item.href !== undefined) {
    return (
      <Link href={item.href} aria-current={current} className={itemClass(item.active)}>
        <ItemBody item={item} />
      </Link>
    );
  }
  return (
    <button type="button" onClick={item.onSelect} aria-current={current} className={itemClass(item.active)}>
      <ItemBody item={item} />
    </button>
  );
}

export function DocsSearchField({
  query,
  onQuery,
  placeholder,
  label,
  id,
}: {
  query: string;
  onQuery: (q: string) => void;
  placeholder: string;
  label: string;
  /** The field's address, for a link elsewhere on the page that takes the reader to it. */
  id?: string;
}) {
  return (
    <Input
      id={id}
      icon="search"
      value={query}
      onChange={(e) => onQuery(e.target.value)}
      placeholder={placeholder}
      aria-label={label}
    />
  );
}

export function DocsSearchResults({ results }: { results: DocsNavItem[] }) {
  return (
    <ul className="flex flex-col gap-0.5 pt-1" aria-label="Search results">
      {results.length === 0 ? (
        <li className="fg-body-sm px-2 py-1 text-subtle">No matches</li>
      ) : (
        results.map((item) => (
          <li key={item.key}>
            <DocsNavEntry item={item} />
          </li>
        ))
      )}
    </ul>
  );
}

/** The search field, then either its results or the grouped page list. */
export function DocsSidebar({
  query,
  onQuery,
  placeholder,
  searchLabel,
  results,
  sections,
  navLabel,
  footer,
  searchId,
}: {
  query: string;
  onQuery: (q: string) => void;
  placeholder: string;
  searchLabel: string;
  results: DocsNavItem[] | null;
  sections: DocsNavSection[];
  navLabel: string;
  footer?: ReactNode;
  searchId?: string;
}) {
  return (
    <div className="flex flex-col gap-2">
      <DocsSearchField query={query} onQuery={onQuery} placeholder={placeholder} label={searchLabel} id={searchId} />
      {results ? (
        <DocsSearchResults results={results} />
      ) : (
        <nav className="flex flex-col gap-3 pt-1" aria-label={navLabel}>
          {sections.map((s) => (
            <div key={s.name} className="flex flex-col gap-0.5">
              <span className="fg-overline px-2 py-1 font-mono text-subtle">{s.name}</span>
              {s.items.map((item) => (
                <DocsNavEntry key={item.key} item={item} />
              ))}
            </div>
          ))}
        </nav>
      )}
      {footer}
    </div>
  );
}

/** One step of a breadcrumb: plain text, or a link where the step is a page of its own. */
export type DocsCrumb = string | { label: string; href: string };

const crumbLabel = (c: DocsCrumb) => (typeof c === "string" ? c : c.label);

/** A page: its breadcrumb, anything the caller puts above the body, and the markdown, with
 *  heading ids assigned after render so the table of contents can scroll to them. `trailing` sits
 *  at the end of the breadcrumb's row, and a breadcrumb that has one stays at the top of the screen
 *  below `lg`. */
export function DocsArticle({
  crumbs,
  body,
  docBasePath,
  docRoute,
  trailing,
  children,
}: {
  crumbs: DocsCrumb[];
  body: string;
  trailing?: ReactNode;
  docBasePath?: string;
  docRoute?: string;
  children?: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // Every render, not only when `body` changes: whatever the caller renders above the body can
  // carry headings too, and the pass is a handful of elements.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    for (const h of el.querySelectorAll("h1, h2, h3")) {
      h.id = slugify(h.textContent ?? "");
    }
  });
  const trail = crumbs.map((crumb, depth) => ({
    crumb,
    path: crumbs
      .slice(0, depth + 1)
      .map(crumbLabel)
      .join(" / "),
    last: depth === crumbs.length - 1,
  }));

  return (
    <div ref={ref} style={{ maxWidth: "72ch" }} className="mx-auto">
      <div
        className={cn(
          "mb-5 flex items-start justify-between gap-4",
          // Below `lg` a reader partway down a long page keeps the way to search and to the door at
          // the top of the screen; from `lg` up the sidebar is beside the page and this scrolls away.
          trailing &&
            "sticky top-0 z-10 -mx-5 border-b border-line-subtle bg-surface px-5 py-2.5 lg:static lg:mx-0 lg:border-b-0 lg:bg-transparent lg:p-0",
        )}
      >
        <nav aria-label="Breadcrumb" className="fg-caption flex flex-wrap items-center gap-1.5 text-subtle">
          {trail.map(({ crumb, path, last }, depth) => (
            <span key={path} className="contents">
              {depth > 0 ? (
                <span aria-hidden className="text-line-strong">
                  /
                </span>
              ) : null}
              {typeof crumb === "string" ? (
                <span className={last ? "text-muted" : undefined}>{crumb}</span>
              ) : (
                <Link href={crumb.href} className="text-muted underline underline-offset-2 hover:text-fg">
                  {crumb.label}
                </Link>
              )}
            </span>
          ))}
        </nav>
        {trailing}
      </div>
      {children}
      <Markdown variant="prose" docBasePath={docBasePath} docRoute={docRoute}>
        {body}
      </Markdown>
    </div>
  );
}

export function DocsToc({ toc }: { toc: TocEntry[] }) {
  function scrollToHeading(slug: string) {
    const target = document.getElementById(slug);
    if (!target) return;
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    target.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
  }
  if (toc.length === 0) return null;
  return (
    <nav aria-label="On this page" className="sticky top-4 flex flex-col gap-1">
      <span className="fg-overline mb-1 px-2 font-mono text-subtle">On this page</span>
      {toc.map((t) => (
        <button
          key={`${t.slug}-${t.level}`}
          type="button"
          onClick={() => scrollToHeading(t.slug)}
          className="truncate rounded-md px-2 py-1 text-left text-12-5 text-muted hover:bg-hover hover:text-fg"
          style={{ paddingLeft: 8 + (t.level - 1) * 10 }}
        >
          {t.text}
        </button>
      ))}
    </nav>
  );
}

/** Sidebar, content, table of contents — sticky sidebar beside the scrolling content.
 *  `contentFirst` puts the content above the sidebar where the columns stack (below `lg`), for a
 *  reader who arrived at a page from a link rather than to browse. */
export function DocsLayout({
  sidebar,
  toc,
  children,
  contentFirst = false,
}: {
  sidebar: ReactNode;
  toc: TocEntry[];
  children: ReactNode;
  contentFirst?: boolean;
}) {
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[260px_minmax(0,1fr)_220px]">
      <Card
        className={cn(
          "lg:sticky lg:top-4 lg:self-start lg:max-h-[calc(100vh-2rem)] lg:overflow-y-auto",
          contentFirst && "order-2 lg:order-none",
        )}
      >
        <CardContent>{sidebar}</CardContent>
      </Card>
      <Card className={contentFirst ? "order-1 lg:order-none" : undefined}>
        <CardContent>{children}</CardContent>
      </Card>
      <div className="hidden lg:block">
        <DocsToc toc={toc} />
      </div>
    </div>
  );
}

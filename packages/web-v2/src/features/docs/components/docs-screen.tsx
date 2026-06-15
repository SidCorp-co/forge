"use client";

// Forge end-user docs (`/docs`). Content is authored in
// `packages/web-v2/content/help/*.md` and bundled at build time into
// `help-content.generated.ts` (see scripts/gen-help-content.mjs) — no backend,
// no filesystem read, no API. Internal engineering docs (repo `docs/`) are NOT
// here and are never served to users.
import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  Card,
  CardContent,
  EmptyState,
  HelpButton,
  Icon,
  Input,
  Markdown,
  PageContainer,
} from "@/design";
import { HELP_DOCS, type HelpDoc } from "../help-content.generated";
import type { TocEntry } from "../types";

function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Derive an h1–h3 table of contents from the raw markdown (skips fenced code). */
function deriveToc(markdown: string): TocEntry[] {
  const lines = markdown.split("\n");
  const toc: TocEntry[] = [];
  let inFence = false;
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = /^(#{1,3})\s+(.+?)\s*#*$/.exec(line);
    if (m) {
      const text = m[2].replace(/[`*_]/g, "").trim();
      toc.push({ level: m[1].length, text, slug: slugify(text) });
    }
  }
  return toc;
}

// Stable section order; anything else falls to the end alphabetically.
const SECTION_ORDER = ["Getting started", "Guides", "Concepts", "Reference", "Troubleshooting"];

interface Section {
  name: string;
  docs: HelpDoc[];
}

function groupSections(docs: HelpDoc[]): Section[] {
  const by = new Map<string, HelpDoc[]>();
  for (const d of docs) {
    const list = by.get(d.section) ?? [];
    list.push(d);
    by.set(d.section, list);
  }
  return [...by.entries()]
    .map(([name, list]) => ({
      name,
      docs: list.sort((a, b) => a.order - b.order || a.title.localeCompare(b.title)),
    }))
    .sort((a, b) => {
      const ia = SECTION_ORDER.indexOf(a.name);
      const ib = SECTION_ORDER.indexOf(b.name);
      if (ia !== -1 || ib !== -1) return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
      return a.name.localeCompare(b.name);
    });
}

export function DocsScreen() {
  const searchParams = useSearchParams();
  const sections = useMemo(() => groupSections(HELP_DOCS), []);
  const firstSlug = sections[0]?.docs[0]?.slug ?? null;

  // `?path=<slug>` deep-link (e.g. from a HelpButton "Learn more").
  const deepLink = searchParams.get("path");
  const [selected, setSelected] = useState<string | null>(
    deepLink && HELP_DOCS.some((d) => d.slug === deepLink) ? deepLink : firstSlug,
  );
  const [query, setQuery] = useState("");
  const contentRef = useRef<HTMLDivElement>(null);

  const doc = useMemo(() => HELP_DOCS.find((d) => d.slug === selected) ?? null, [selected]);
  const toc = useMemo(() => (doc ? deriveToc(doc.body) : []), [doc]);

  const searchMatches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return null;
    return HELP_DOCS.filter(
      (d) => d.title.toLowerCase().includes(q) || d.body.toLowerCase().includes(q),
    );
  }, [query]);

  // Assign heading ids after render so the TOC can scroll-link.
  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    for (const h of el.querySelectorAll("h1, h2, h3")) {
      h.id = slugify(h.textContent ?? "");
    }
  }, [doc]);

  function scrollToHeading(slug: string) {
    const target = document.getElementById(slug);
    if (!target) return;
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    target.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
  }

  function docButtonClass(active: boolean) {
    return active
      ? "flex w-full items-center gap-1.5 rounded-md bg-hover px-2 py-1 text-left text-[13px] font-semibold text-fg"
      : "flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-[13px] text-muted hover:bg-hover hover:text-fg";
  }

  return (
    <PageContainer className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="fg-h2">Docs</h1>
          <p className="fg-body-sm text-muted">Guides for using Forge.</p>
        </div>
        <HelpButton
          summary="How to use Forge — getting started, pairing a runner, managing your organization, and troubleshooting. Pick a page from the left, read it in the center, and jump around with the table of contents."
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
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[260px_minmax(0,1fr)_220px]">
          {/* Sidebar + search */}
          <Card>
            <CardContent>
              <div className="flex flex-col gap-2">
                <Input
                  icon="search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search docs"
                  aria-label="Search docs"
                />
                {searchMatches ? (
                  <ul className="flex flex-col gap-0.5 pt-1" aria-label="Search results">
                    {searchMatches.length === 0 ? (
                      <li className="fg-body-sm px-2 py-1 text-subtle">No matches</li>
                    ) : (
                      searchMatches.map((d) => (
                        <li key={d.slug}>
                          <button
                            type="button"
                            onClick={() => setSelected(d.slug)}
                            className={docButtonClass(selected === d.slug)}
                          >
                            <Icon name="book" size={13} className="flex-none text-subtle" />
                            <span className="truncate">{d.title}</span>
                          </button>
                        </li>
                      ))
                    )}
                  </ul>
                ) : (
                  <nav className="flex flex-col gap-3 pt-1" aria-label="Docs">
                    {sections.map((s) => (
                      <div key={s.name} className="flex flex-col gap-0.5">
                        <span className="fg-overline px-2 py-1 font-mono text-subtle">{s.name}</span>
                        {s.docs.map((d) => (
                          <button
                            key={d.slug}
                            type="button"
                            onClick={() => setSelected(d.slug)}
                            aria-current={selected === d.slug ? "page" : undefined}
                            className={docButtonClass(selected === d.slug)}
                          >
                            <Icon name="book" size={13} className="flex-none text-subtle" />
                            <span className="truncate">{d.title}</span>
                          </button>
                        ))}
                      </div>
                    ))}
                  </nav>
                )}
              </div>
            </CardContent>
          </Card>

          {/* Content pane */}
          <Card>
            <CardContent>
              {!doc ? (
                <EmptyState
                  title="Select a page"
                  message="Pick a page from the left to start reading."
                  mascot={false}
                />
              ) : (
                <div ref={contentRef} style={{ maxWidth: "72ch" }} className="mx-auto">
                  <nav
                    aria-label="Breadcrumb"
                    className="fg-caption mb-5 flex flex-wrap items-center gap-1.5 text-subtle"
                  >
                    <span>{doc.section}</span>
                    <span aria-hidden className="text-line-strong">
                      /
                    </span>
                    <span className="text-muted">{doc.title}</span>
                  </nav>
                  <Markdown variant="prose" docBasePath={doc.slug}>
                    {doc.body}
                  </Markdown>
                </div>
              )}
            </CardContent>
          </Card>

          {/* TOC */}
          <div className="hidden lg:block">
            {toc.length > 0 && (
              <nav aria-label="On this page" className="sticky top-4 flex flex-col gap-1">
                <span className="fg-overline mb-1 px-2 font-mono text-subtle">On this page</span>
                {toc.map((t) => (
                  <button
                    key={`${t.slug}-${t.level}`}
                    type="button"
                    onClick={() => scrollToHeading(t.slug)}
                    className="truncate rounded-md px-2 py-1 text-left text-[12.5px] text-muted hover:bg-hover hover:text-fg"
                    style={{ paddingLeft: 8 + (t.level - 1) * 10 }}
                  >
                    {t.text}
                  </button>
                ))}
              </nav>
            )}
          </div>
        </div>
      )}
    </PageContainer>
  );
}

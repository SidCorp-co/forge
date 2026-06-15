"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  Card,
  CardContent,
  EmptyState,
  ErrorState,
  HelpButton,
  Icon,
  Input,
  Markdown,
  PageContainer,
  Skeleton,
} from "@/design";
import { formatApiError } from "@/lib/api/error";
import { usePlatformDocContent, usePlatformDocsTree } from "../hooks";
import type { DocNode, TocEntry } from "../types";

function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Flatten the tree to its file paths (for search). */
function flattenFiles(nodes: DocNode[], out: string[] = []): string[] {
  for (const n of nodes) {
    if (n.type === "file") out.push(n.path);
    if (n.children) flattenFiles(n.children, out);
  }
  return out;
}

/** Human-friendly label for a tree node: drop the extension, de-kebab, Title
 *  Case. Leaves acronym-style names (README, CHANGELOG) intact. */
function prettyLabel(name: string): string {
  return name
    .replace(/\.(md|mdx)$/i, "")
    .split(/[-_]/)
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}

/** Friendly default landing doc: prefer quickstart/README/index, else the
 *  first file in tree order. */
function defaultDoc(nodes: DocNode[]): string | null {
  const files = flattenFiles(nodes);
  const prefer = [
    "docs/quickstart.md",
    "quickstart.md",
    "README.md",
    "docs/README.md",
    "docs/index.md",
    "index.md",
  ];
  for (const p of prefer) {
    const hit = files.find((f) => f.toLowerCase() === p.toLowerCase());
    if (hit) return hit;
  }
  return files[0] ?? null;
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

function TreeNode({
  node,
  depth,
  selected,
  onSelect,
}: {
  node: DocNode;
  depth: number;
  selected: string | null;
  onSelect: (path: string) => void;
}) {
  const [open, setOpen] = useState(true);
  if (node.type === "dir") {
    return (
      <li>
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-[13px] font-semibold text-muted hover:bg-hover"
          style={{ paddingLeft: 8 + depth * 12 }}
          aria-expanded={open}
        >
          <Icon name={open ? "chevronDown" : "chevronRight"} size={13} />
          <Icon name="folder" size={13} />
          {prettyLabel(node.name)}
        </button>
        {open && node.children && (
          <ul>
            {node.children.map((c) => (
              <TreeNode
                key={c.path}
                node={c}
                depth={depth + 1}
                selected={selected}
                onSelect={onSelect}
              />
            ))}
          </ul>
        )}
      </li>
    );
  }
  const active = selected === node.path;
  return (
    <li>
      <button
        type="button"
        onClick={() => onSelect(node.path)}
        aria-current={active ? "page" : undefined}
        className={
          active
            ? "flex w-full items-center gap-1.5 rounded-md bg-hover px-2 py-1 text-left text-[13px] font-semibold text-fg"
            : "flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-[13px] text-muted hover:bg-hover hover:text-fg"
        }
        style={{ paddingLeft: 8 + depth * 12 }}
      >
        <Icon name="book" size={13} className="flex-none text-subtle" />
        <span className="truncate">{prettyLabel(node.name)}</span>
      </button>
    </li>
  );
}

export function DocsScreen() {
  // Deep-link target: `?path=docs/foo.md` (e.g. from a HelpButton "Learn more").
  // Seeds the initial selection so the linked doc opens directly.
  const searchParams = useSearchParams();
  const initialPath = searchParams.get("path");
  const [selected, setSelected] = useState<string | null>(initialPath);
  const [query, setQuery] = useState("");
  const contentRef = useRef<HTMLDivElement>(null);

  // Forge's own platform docs — global, served from the deployment (not a
  // project repo). See core docs/platform-routes.ts.
  const tree = usePlatformDocsTree();
  const doc = usePlatformDocContent(selected || undefined);

  // Land on a friendly default (quickstart/README) once the tree loads.
  useEffect(() => {
    if (!selected && tree.data?.items) {
      const first = defaultDoc(tree.data.items);
      if (first) setSelected(first);
    }
  }, [tree.data, selected]);

  const toc = useMemo(() => (doc.data?.content ? deriveToc(doc.data.content) : []), [doc.data]);

  const searchMatches = useMemo(() => {
    if (!query.trim() || !tree.data?.items) return null;
    const q = query.trim().toLowerCase();
    return flattenFiles(tree.data.items).filter((p) => p.toLowerCase().includes(q));
  }, [query, tree.data]);

  // Assign heading ids after the markdown renders so the TOC can scroll-link.
  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    const headings = el.querySelectorAll("h1, h2, h3");
    headings.forEach((h) => {
      h.id = slugify(h.textContent ?? "");
    });
  }, [doc.data]);

  function scrollToHeading(slug: string) {
    const target = document.getElementById(slug);
    if (!target) return;
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    target.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
  }

  return (
    <PageContainer className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="fg-h2">Docs</h1>
          <p className="fg-body-sm text-muted">Forge documentation.</p>
        </div>
        <div className="flex items-center gap-2">
          <HelpButton
            summary="Forge's own documentation — quickstart, guides, architecture, and module references, plus top-level files (README, CHANGELOG). Pick a file from the tree, read it in the center pane, and jump around with the table of contents."
            actions={[
              "Search filters the file tree by path",
              "Click a TOC entry to jump to that heading",
            ]}
          />
        </div>
      </div>

      {
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[260px_minmax(0,1fr)_220px]">
          {/* Tree + search */}
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
                {tree.isLoading ? (
                  <div className="flex flex-col gap-1.5 pt-1">
                    <Skeleton className="h-6 w-full" />
                    <Skeleton className="h-6 w-full" />
                    <Skeleton className="h-6 w-3/4" />
                  </div>
                ) : tree.isError ? (
                  <ErrorState message={formatApiError(tree.error)} onRetry={() => tree.refetch()} />
                ) : (tree.data?.items.length ?? 0) === 0 ? (
                  <EmptyState
                    title="No docs"
                    message="No Forge documentation is available on this deployment."
                    mascot={false}
                  />
                ) : searchMatches ? (
                  <ul className="flex flex-col gap-0.5 pt-1" aria-label="Search results">
                    {searchMatches.length === 0 ? (
                      <li className="fg-body-sm px-2 py-1 text-subtle">No matches</li>
                    ) : (
                      searchMatches.map((p) => (
                        <li key={p}>
                          <button
                            type="button"
                            onClick={() => setSelected(p)}
                            className={
                              selected === p
                                ? "flex w-full items-center gap-1.5 rounded-md bg-hover px-2 py-1 text-left text-[13px] font-semibold text-fg"
                                : "flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-[13px] text-muted hover:bg-hover hover:text-fg"
                            }
                          >
                            <Icon name="book" size={13} className="flex-none text-subtle" />
                            <span className="truncate">{p}</span>
                          </button>
                        </li>
                      ))
                    )}
                  </ul>
                ) : (
                  <ul className="flex flex-col gap-0.5 pt-1" aria-label="Docs tree">
                    {tree.data?.items.map((n) => (
                      <TreeNode
                        key={n.path}
                        node={n}
                        depth={0}
                        selected={selected}
                        onSelect={setSelected}
                      />
                    ))}
                  </ul>
                )}
              </div>
            </CardContent>
          </Card>

          {/* Content pane */}
          <Card>
            <CardContent>
              {!selected ? (
                <EmptyState
                  title="Select a doc"
                  message="Pick a file from the tree to start reading."
                  mascot={false}
                />
              ) : doc.isLoading ? (
                <div className="flex flex-col gap-2">
                  <Skeleton className="h-7 w-1/2" />
                  <Skeleton className="h-4 w-full" />
                  <Skeleton className="h-4 w-full" />
                  <Skeleton className="h-4 w-2/3" />
                </div>
              ) : doc.isError ? (
                <ErrorState message={formatApiError(doc.error)} onRetry={() => doc.refetch()} />
              ) : (
                <div ref={contentRef} style={{ maxWidth: "72ch" }} className="mx-auto">
                  {doc.data?.path && (
                    <nav
                      aria-label="Breadcrumb"
                      className="fg-caption mb-5 flex flex-wrap items-center gap-1.5 text-subtle"
                    >
                      {doc.data.path.split("/").map((seg, i, arr) => (
                        <span
                          key={arr.slice(0, i + 1).join("/")}
                          className="flex items-center gap-1.5"
                        >
                          {i > 0 && <span aria-hidden className="text-line-strong">/</span>}
                          <span className={i === arr.length - 1 ? "text-muted" : undefined}>
                            {prettyLabel(seg)}
                          </span>
                        </span>
                      ))}
                    </nav>
                  )}
                  <Markdown variant="prose">{doc.data?.content ?? ""}</Markdown>
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
      }
    </PageContainer>
  );
}

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
  Select,
  Skeleton,
} from "@/design";
import { useProjects } from "@/features/projects/hooks";
import { formatApiError } from "@/lib/api/error";
import { useDocContent, useDocsTree } from "../hooks";
import type { DocNode, TocEntry } from "../types";

function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** First file node in DFS order — the default selection. */
function firstFile(nodes: DocNode[]): string | null {
  for (const n of nodes) {
    if (n.type === "file") return n.path;
    if (n.children) {
      const found = firstFile(n.children);
      if (found) return found;
    }
  }
  return null;
}

/** Flatten the tree to its file paths (for search). */
function flattenFiles(nodes: DocNode[], out: string[] = []): string[] {
  for (const n of nodes) {
    if (n.type === "file") out.push(n.path);
    if (n.children) flattenFiles(n.children, out);
  }
  return out;
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
          {node.name}
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
        <span className="truncate">{node.name}</span>
      </button>
    </li>
  );
}

export function DocsScreen() {
  const projects = useProjects();
  // Deep-link target: `?path=docs/foo.md` (e.g. from a HelpButton "Learn more").
  // Seeds the initial selection so the linked doc opens directly.
  const searchParams = useSearchParams();
  const initialPath = searchParams.get("path");
  const [projectId, setProjectId] = useState<string>("");
  const [selected, setSelected] = useState<string | null>(initialPath);
  const [query, setQuery] = useState("");
  const contentRef = useRef<HTMLDivElement>(null);
  const prevProjectId = useRef<string>("");

  useEffect(() => {
    if (!projectId && projects.data && projects.data.length > 0) {
      setProjectId(projects.data[0].id);
    }
  }, [projects.data, projectId]);

  // Reset the selected doc when the user switches project — but NOT on the
  // initial project resolution, so a `?path=` deep-link survives first load.
  useEffect(() => {
    if (prevProjectId.current && prevProjectId.current !== projectId) {
      setSelected(null);
    }
    prevProjectId.current = projectId;
  }, [projectId]);

  const tree = useDocsTree(projectId || undefined);
  const doc = useDocContent(projectId || undefined, selected || undefined);

  // Default to the first file once the tree loads.
  useEffect(() => {
    if (!selected && tree.data?.items) {
      const first = firstFile(tree.data.items);
      if (first) setSelected(first);
    }
  }, [tree.data, selected]);

  const projectOptions = useMemo(
    () => (projects.data ?? []).map((p) => ({ value: p.id, label: p.name })),
    [projects.data],
  );

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
    <div className="mx-auto flex w-full max-w-[1280px] flex-col gap-4 px-6 py-6">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="fg-h2">Docs</h1>
          <p className="fg-body-sm text-muted">Project documentation from the repo.</p>
        </div>
        <div className="flex items-center gap-2">
          {projectOptions.length > 0 && (
            <div className="w-[200px]">
              <Select options={projectOptions} value={projectId} onChange={setProjectId} />
            </div>
          )}
          <HelpButton
            summary="Browse this project's markdown docs — top-level files (README, CLAUDE, CHANGELOG) plus everything under docs/. Pick a file from the tree, read it in the center pane, and jump around with the table of contents."
            actions={[
              "Search filters the file tree by path",
              "Click a TOC entry to jump to that heading",
            ]}
          />
        </div>
      </div>

      {projects.isLoading ? (
        <Skeleton className="h-[420px] w-full" />
      ) : projectOptions.length === 0 ? (
        <Card>
          <CardContent>
            <EmptyState title="No projects" message="Create a project to browse its docs." mascot={false} />
          </CardContent>
        </Card>
      ) : (
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
                    message="This project has no markdown docs in its repo."
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
                  <p className="fg-overline mb-3 font-mono text-subtle">{doc.data?.path}</p>
                  <Markdown>{doc.data?.content ?? ""}</Markdown>
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
    </div>
  );
}

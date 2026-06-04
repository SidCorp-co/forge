'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { ChevronDown, ChevronRight, FileText, FolderOpen, RotateCw, Search } from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import { Markdown } from '@/components/ui/markdown';
import { useProjects } from '@/features/project/hooks/use-projects';
import { useDocContent, useDocsTree } from '../hooks';
import type { DocNode, TocEntry } from '../types';

function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** First file node in DFS order — the default selection. */
function firstFile(nodes: DocNode[]): string | null {
  for (const n of nodes) {
    if (n.type === 'file') return n.path;
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
    if (n.type === 'file') out.push(n.path);
    if (n.children) flattenFiles(n.children, out);
  }
  return out;
}

/** Derive an h1–h3 table of contents from the raw markdown (skips fenced code). */
function deriveToc(markdown: string): TocEntry[] {
  const lines = markdown.split('\n');
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
      const text = m[2].replace(/[`*_]/g, '').trim();
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
  if (node.type === 'dir') {
    return (
      <li>
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="flex w-full items-center gap-1.5 rounded-sm px-2 py-1 text-left text-[13px] font-semibold text-on-surface-variant hover:bg-surface-container-high"
          style={{ paddingLeft: 8 + depth * 12 }}
          aria-expanded={open}
        >
          {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          <FolderOpen className="h-3.5 w-3.5" />
          {node.name}
        </button>
        {open && node.children && (
          <ul>
            {node.children.map((c) => (
              <TreeNode key={c.path} node={c} depth={depth + 1} selected={selected} onSelect={onSelect} />
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
        aria-current={active ? 'page' : undefined}
        className={cn(
          'flex w-full items-center gap-1.5 rounded-sm px-2 py-1 text-left text-[13px]',
          active
            ? 'bg-surface-container-high font-semibold text-primary'
            : 'text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface',
        )}
        style={{ paddingLeft: 8 + depth * 12 }}
      >
        <FileText className="h-3.5 w-3.5 flex-none text-outline" />
        <span className="truncate">{node.name}</span>
      </button>
    </li>
  );
}

/** Help / Docs hub — browse the selected project's markdown docs tree, render a
 *  file with markdown + a derived table of contents (ISS-384). Reuses the
 *  ISS-305 per-project docs API. */
export function DocsScreen() {
  const { data: projects, isLoading: projectsLoading } = useProjects();
  const searchParams = useSearchParams();
  const initialPath = searchParams.get('path');
  const [projectId, setProjectId] = useState<string>('');
  const [selected, setSelected] = useState<string | null>(initialPath);
  const [query, setQuery] = useState('');
  const contentRef = useRef<HTMLDivElement>(null);
  const prevProjectId = useRef<string>('');

  useEffect(() => {
    if (!projectId && projects && projects.length > 0) {
      setProjectId(projects[0].id);
    }
  }, [projects, projectId]);

  // Reset selection on a real project switch — but not on initial resolution,
  // so a `?path=` deep-link survives first load.
  useEffect(() => {
    if (prevProjectId.current && prevProjectId.current !== projectId) {
      setSelected(null);
    }
    prevProjectId.current = projectId;
  }, [projectId]);

  const tree = useDocsTree(projectId || undefined);
  const doc = useDocContent(projectId || undefined, selected || undefined);

  useEffect(() => {
    if (!selected && tree.data?.items) {
      const first = firstFile(tree.data.items);
      if (first) setSelected(first);
    }
  }, [tree.data, selected]);

  const toc = useMemo(() => (doc.data?.content ? deriveToc(doc.data.content) : []), [doc.data]);

  const searchMatches = useMemo(() => {
    if (!query.trim() || !tree.data?.items) return null;
    const q = query.trim().toLowerCase();
    return flattenFiles(tree.data.items).filter((p) => p.toLowerCase().includes(q));
  }, [query, tree.data]);

  // Assign heading ids after render so the TOC can scroll-link.
  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    el.querySelectorAll('h1, h2, h3').forEach((h) => {
      h.id = slugify(h.textContent ?? '');
    });
  }, [doc.data]);

  function scrollToHeading(slug: string) {
    const target = document.getElementById(slug);
    if (!target) return;
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    target.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
  }

  return (
    <div className="mx-auto flex w-full max-w-[1280px] flex-col gap-4 px-4 py-6 md:px-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-on-surface">Help &amp; Docs</h1>
          <p className="mt-0.5 text-sm text-on-surface-variant">
            Project documentation from the repo — guides, README, and CHANGELOG.
          </p>
        </div>
        {projects && projects.length > 0 && (
          <select
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
            aria-label="Project"
            className="rounded-sm border border-outline-variant/40 bg-surface-container-low px-3 py-1.5 text-sm text-on-surface"
          >
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        )}
      </div>

      {projectsLoading ? (
        <div className="h-[420px] animate-pulse rounded-md bg-surface-container-low" />
      ) : !projects || projects.length === 0 ? (
        <div className="rounded-md border border-outline-variant/30 bg-surface-container-low p-8 text-center">
          <p className="text-sm text-on-surface-variant">Create a project to browse its docs.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[260px_minmax(0,1fr)_220px]">
          {/* Tree + search */}
          <div className="rounded-md border border-outline-variant/30 bg-surface-container-low p-3">
            <div className="relative mb-2">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-outline" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search docs"
                aria-label="Search docs"
                className="w-full rounded-sm border border-outline-variant/40 bg-surface py-1.5 pl-8 pr-2 text-[13px] text-on-surface placeholder:text-outline"
              />
            </div>
            {tree.isLoading ? (
              <div className="space-y-1.5 pt-1">
                <div className="h-6 animate-pulse rounded bg-surface-container-high" />
                <div className="h-6 animate-pulse rounded bg-surface-container-high" />
                <div className="h-6 w-3/4 animate-pulse rounded bg-surface-container-high" />
              </div>
            ) : tree.isError ? (
              <div className="px-2 py-4 text-center">
                <p className="text-[13px] text-on-surface-variant">Couldn&apos;t load the docs tree.</p>
                <button
                  onClick={() => tree.refetch()}
                  className="mt-2 inline-flex items-center gap-1.5 text-xs font-semibold text-primary hover:underline"
                >
                  <RotateCw className="h-3 w-3" /> Retry
                </button>
              </div>
            ) : (tree.data?.items.length ?? 0) === 0 ? (
              <p className="px-2 py-4 text-center text-[13px] text-outline">
                This project has no markdown docs in its repo.
              </p>
            ) : searchMatches ? (
              <ul className="flex flex-col gap-0.5 pt-1" aria-label="Search results">
                {searchMatches.length === 0 ? (
                  <li className="px-2 py-1 text-[13px] text-outline">No matches</li>
                ) : (
                  searchMatches.map((p) => (
                    <li key={p}>
                      <button
                        type="button"
                        onClick={() => setSelected(p)}
                        className={cn(
                          'flex w-full items-center gap-1.5 rounded-sm px-2 py-1 text-left text-[13px]',
                          selected === p
                            ? 'bg-surface-container-high font-semibold text-primary'
                            : 'text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface',
                        )}
                      >
                        <FileText className="h-3.5 w-3.5 flex-none text-outline" />
                        <span className="truncate">{p}</span>
                      </button>
                    </li>
                  ))
                )}
              </ul>
            ) : (
              <ul className="flex flex-col gap-0.5 pt-1" aria-label="Docs tree">
                {tree.data?.items.map((n) => (
                  <TreeNode key={n.path} node={n} depth={0} selected={selected} onSelect={setSelected} />
                ))}
              </ul>
            )}
          </div>

          {/* Content pane */}
          <div className="rounded-md border border-outline-variant/30 bg-surface-container-low p-4 md:p-5">
            {!selected ? (
              <p className="py-12 text-center text-sm text-on-surface-variant">
                Pick a file from the tree to start reading.
              </p>
            ) : doc.isLoading ? (
              <div className="space-y-2">
                <div className="h-7 w-1/2 animate-pulse rounded bg-surface-container-high" />
                <div className="h-4 animate-pulse rounded bg-surface-container-high" />
                <div className="h-4 animate-pulse rounded bg-surface-container-high" />
                <div className="h-4 w-2/3 animate-pulse rounded bg-surface-container-high" />
              </div>
            ) : doc.isError ? (
              <div className="py-12 text-center">
                <p className="text-sm text-on-surface-variant">Couldn&apos;t load this doc.</p>
                <button
                  onClick={() => doc.refetch()}
                  className="mt-3 inline-flex items-center gap-1.5 text-xs font-semibold text-primary hover:underline"
                >
                  <RotateCw className="h-3 w-3" /> Retry
                </button>
              </div>
            ) : (
              <div ref={contentRef} style={{ maxWidth: '72ch' }} className="mx-auto">
                <p className="mb-3 font-mono text-[11px] uppercase tracking-widest text-outline">{doc.data?.path}</p>
                <Markdown>{doc.data?.content ?? ''}</Markdown>
              </div>
            )}
          </div>

          {/* TOC */}
          <div className="hidden lg:block">
            {toc.length > 0 && (
              <nav aria-label="On this page" className="sticky top-4 flex flex-col gap-1">
                <span className="mb-1 px-2 font-mono text-[11px] uppercase tracking-widest text-outline">
                  On this page
                </span>
                {toc.map((t) => (
                  <button
                    key={`${t.slug}-${t.level}`}
                    type="button"
                    onClick={() => scrollToHeading(t.slug)}
                    className="truncate rounded-sm px-2 py-1 text-left text-[12.5px] text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface"
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

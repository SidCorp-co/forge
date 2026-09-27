// The logic behind the documentation reader, shared by the in-app `/docs` screen
// and the public `/guides` pages so the two cannot group or outline a page differently.
import type { TocEntry } from "./types";

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Derive an h1–h3 table of contents from the raw markdown (skips fenced code). */
export function deriveToc(markdown: string): TocEntry[] {
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

/** The order the help sections are listed in; anything unlisted falls to the end alphabetically. */
export const HELP_SECTION_ORDER: readonly string[] = [
  "Getting started",
  "Guides",
  "Connect an assistant",
  "Concepts",
  "Reference",
  "Troubleshooting",
];

export interface Groupable {
  section: string;
  order: number;
  title: string;
}

export interface Section<T extends Groupable> {
  name: string;
  docs: T[];
}

/** Pages grouped by `section` and ordered by `sectionOrder`, each section's pages by `order` then title. */
export function groupSections<T extends Groupable>(
  docs: readonly T[],
  sectionOrder: readonly string[],
): Section<T>[] {
  const by = new Map<string, T[]>();
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
      const ia = sectionOrder.indexOf(a.name);
      const ib = sectionOrder.indexOf(b.name);
      if (ia !== -1 || ib !== -1) return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
      return a.name.localeCompare(b.name);
    });
}

/** The pages whose title or body holds the query, case-insensitively; `null` for an empty query. */
export function searchDocs<T extends { title: string; body: string; summary?: string | null }>(
  docs: readonly T[],
  query: string,
): T[] | null {
  const q = query.trim().toLowerCase();
  if (!q) return null;
  return docs.filter(
    (d) =>
      d.title.toLowerCase().includes(q) ||
      d.body.toLowerCase().includes(q) ||
      (d.summary ?? "").toLowerCase().includes(q),
  );
}

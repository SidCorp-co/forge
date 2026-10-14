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

/** The pages whose title, summary or body holds the query, case-insensitively, those whose title
 *  holds it first and each group in the order given; `null` for an empty query. */
export function searchDocs<T extends { title: string; body: string; summary?: string | null }>(
  docs: readonly T[],
  query: string,
): T[] | null {
  const q = query.trim().toLowerCase();
  if (!q) return null;
  const inTitle: T[] = [];
  const elsewhere: T[] = [];
  for (const d of docs) {
    if (d.title.toLowerCase().includes(q)) inTitle.push(d);
    else if (d.body.toLowerCase().includes(q) || (d.summary ?? "").toLowerCase().includes(q)) elsewhere.push(d);
  }
  return [...inTitle, ...elsewhere];
}

/** `text` cut around the first place it holds `query`, case-insensitively; `null` where it holds none. */
export interface MatchSpan {
  before: string;
  match: string;
  after: string;
}

export function splitAtMatch(text: string, query: string): MatchSpan | null {
  const q = query.trim().toLowerCase();
  if (!q) return null;
  const at = text.toLowerCase().indexOf(q);
  if (at === -1) return null;
  return { before: text.slice(0, at), match: text.slice(at, at + q.length), after: text.slice(at + q.length) };
}

/** Where in a page the query was found: the section heading it sits under, and the words around it. */
export interface MatchExcerpt extends MatchSpan {
  heading: string | null;
}

const BEFORE = 40;
const AFTER = 120;

/** A markdown line as a reader sees it: no heading, quote or list marker, link target or emphasis. */
function plainLine(line: string): string {
  return line
    .replace(/^\s*(#{1,6}\s+|>\s?|[-*+]\s+|\d+\.\s+)/, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/`|\*\*/g, "")
    .replace(/\|/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function trimmed(span: MatchSpan): MatchSpan {
  const head = span.before.length > BEFORE ? `…${span.before.slice(-BEFORE).replace(/^\S*\s/, "")}` : span.before;
  const tail = span.after.length > AFTER ? `${span.after.slice(0, AFTER).replace(/\s\S*$/, "")}…` : span.after;
  return { before: head, match: span.match, after: tail };
}

/** The first line of the page's body that holds the query, with the heading above it; else its
 *  summary; `null` where only the title holds it. A heading repeating the page's title is neither a
 *  match nor a place, the title already being shown; a line whose words hold the query only inside
 *  markup (a link's address) is shown as written. */
export function matchExcerpt(
  doc: { title: string; body: string; summary?: string | null },
  query: string,
): MatchExcerpt | null {
  const title = doc.title.trim().toLowerCase();
  let heading: string | null = null;
  let inFence = false;
  for (const line of doc.body.split("\n")) {
    if (/^\s*```/.test(line)) {
      const marker = splitAtMatch(line.trim(), query);
      if (marker) return { heading, ...trimmed(marker) };
      inFence = !inFence;
      continue;
    }
    const h = inFence ? null : /^(#{1,3})\s+(.+?)\s*#*$/.exec(line);
    const text = h ? plainLine(h[2]) : plainLine(line);
    if (h && text.toLowerCase() === title) {
      heading = null;
      continue;
    }
    const span = splitAtMatch(text, query) ?? splitAtMatch(line.trim(), query);
    if (span) return { heading: h ? null : heading, ...trimmed(span) };
    if (h) heading = text;
  }
  const inSummary = splitAtMatch(doc.summary ?? "", query);
  return inSummary ? { heading: null, ...trimmed(inSummary) } : null;
}

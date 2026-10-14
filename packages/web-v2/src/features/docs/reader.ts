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
 *  as shown holds it first and each group in the order given; `null` for an empty query. A body is
 *  matched as written and as a reader sees it, so emphasis or a wrap between the words still finds it. */
export function searchDocs<T extends { title: string; body: string; summary?: string | null }>(
  docs: readonly T[],
  query: string,
): T[] | null {
  const q = query.trim().toLowerCase();
  if (!q) return null;
  const inTitle: T[] = [];
  const elsewhere: T[] = [];
  for (const d of docs) {
    if (plainText(d.title).toLowerCase().includes(q)) inTitle.push(d);
    else if (bodyText(d.body).includes(q) || (d.summary ?? "").toLowerCase().includes(q)) elsewhere.push(d);
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

const TAG = /^<[A-Za-z/!?][^<>]*>/;
const LINK = /^!?\[([^\]]*)\]\([^)]*\)/;
const TAG_START = /[A-Za-z/!?]/;
const WORD = /[\p{L}\p{N}]/u;
const SPACE = /\s/;

/** Whether the `*` or `_` at `i` opens or closes emphasis rather than standing for itself: it
 *  touches a word on one side, and an `_` never sits inside one (`some_name`). */
function marksEmphasis(src: string, i: number): boolean {
  const prev = src[i - 1];
  const next = src[i + 1];
  const opens = next !== undefined && !SPACE.test(next);
  const closes = prev !== undefined && !SPACE.test(prev);
  if (src[i] === "*") return opens || closes;
  const inWord = prev !== undefined && next !== undefined && WORD.test(prev) && WORD.test(next);
  return (opens || closes) && !inWord;
}

/** Inline markdown as runs of prose and code, read once from left to right: no HTML tag, link
 *  target, emphasis or code mark, a code span's text kept as written. What is dropped never joins
 *  its neighbours into a tag: a `<` read as text is kept apart from a letter after it, so no input
 *  reads as `<script` once its markup is gone. */
function inlineRuns(src: string): Array<{ text: string; code: boolean }> {
  const runs: Array<{ text: string; code: boolean }> = [];
  let looseAngle = false;
  const emit = (text: string, code: boolean) => {
    let out = "";
    for (const ch of text) {
      if (looseAngle && TAG_START.test(ch)) out += " ";
      out += ch;
      looseAngle = !code && ch === "<";
    }
    const last = runs[runs.length - 1];
    if (last && last.code === code) last.text += out;
    else if (out) runs.push({ text: out, code });
  };
  const read = (text: string) => {
    let i = 0;
    while (i < text.length) {
      const rest = text.slice(i);
      if (rest.startsWith("`")) {
        const fence = /^`+/.exec(rest)?.[0] ?? "`";
        const close = rest.indexOf(fence, fence.length);
        if (close !== -1) emit(rest.slice(fence.length, close), true);
        i += close !== -1 ? close + fence.length : fence.length;
      } else if (rest.startsWith("**") || rest.startsWith("__")) {
        i += 2;
      } else if ((rest[0] === "*" || rest[0] === "_") && marksEmphasis(text, i)) {
        i += 1;
      } else if (rest.startsWith("|")) {
        emit(" ", false);
        i += 1;
      } else if (TAG.test(rest)) {
        i += TAG.exec(rest)?.[0].length ?? 1;
      } else if (LINK.test(rest)) {
        const link = LINK.exec(rest) ?? ["", ""];
        read(link[1]);
        i += link[0].length;
      } else {
        emit(text[i], false);
        i += 1;
      }
    }
  };
  read(src);
  return runs;
}

/** Inline markdown as a reader sees it, its whitespace collapsed: a page title is searched, and the
 *  tab names a page, in this form. */
export function plainText(src: string): string {
  return inlineRuns(src)
    .map((r) => r.text)
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}

/** One run of a title as shown: prose or code, and whether it holds the words searched for. */
export interface TitlePart {
  text: string;
  code: boolean;
  marked: boolean;
}

/** A title as prose and code runs, cut where the first place it holds `query` starts and ends. */
export function titleParts(title: string, query: string): TitlePart[] {
  const runs = inlineRuns(title.trim());
  const shown = runs.map((r) => r.text).join("");
  const q = query.trim().toLowerCase();
  const at = q ? shown.toLowerCase().indexOf(q) : -1;
  const [from, to] = at === -1 ? [-1, -1] : [at, at + q.length];
  const parts: TitlePart[] = [];
  let offset = 0;
  for (const run of runs) {
    const end = offset + run.text.length;
    const cuts = [offset, ...[from, to].filter((c) => c > offset && c < end), end];
    for (let k = 0; k < cuts.length - 1; k++) {
      const text = shown.slice(cuts[k], cuts[k + 1]);
      parts.push({ text, code: run.code, marked: cuts[k] >= from && cuts[k] < to });
    }
    offset = end;
  }
  return parts;
}

/** One block of a page's body as a reader meets it: a heading, a line of code, or a paragraph,
 *  list item or quote with its source wraps joined, or a table row with its cells set apart. */
interface Block {
  kind: "heading" | "code" | "text";
  level: number;
  /** As written, wraps joined, for a match that sits only in markup such as a link's address. */
  raw: string;
  shown: string;
}

const HEADING = /^(#{1,6})\s+(.+?)\s*#*$/;
const FENCE = /^\s*```/;
const ITEM = /^\s*(?:[-*+]|\d+[.)])\s+/;
const QUOTE = /^\s*>\s?/;
const ROW = /^\s*\|/;

function readBlocks(body: string): Block[] {
  const blocks: Block[] = [];
  let lines: string[] = [];
  let quoted = false;
  const flush = () => {
    if (lines.length === 0) return;
    const raw = lines.join(" ");
    blocks.push({ kind: "text", level: 0, raw, shown: plainText(raw) });
    lines = [];
  };
  let inFence = false;
  for (const line of body.split("\n")) {
    if (FENCE.test(line)) {
      flush();
      blocks.push({ kind: "code", level: 0, raw: line.trim(), shown: line.trim() });
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      if (line.trim()) blocks.push({ kind: "code", level: 0, raw: line.trim(), shown: line.trim() });
      continue;
    }
    const h = HEADING.exec(line);
    if (h) {
      flush();
      blocks.push({ kind: "heading", level: h[1].length, raw: line.trim(), shown: plainText(h[2]) });
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    if (ROW.test(line)) {
      flush();
      const cells = line.trim().replace(/^\||\|$/g, "").split("|");
      const rule = cells.every((c) => /^\s*:?-+:?\s*$/.test(c));
      const shown = rule ? "" : cells.map(plainText).filter(Boolean).join(" · ");
      blocks.push({ kind: "text", level: 0, raw: line.trim(), shown });
      continue;
    }
    const item = ITEM.exec(line);
    const quote = QUOTE.exec(line);
    if (item || (quote && !quoted)) flush();
    quoted = quote !== null;
    lines.push(line.slice((item ?? quote)?.[0].length ?? 0).trim());
  }
  flush();
  return blocks;
}

const searched = new Map<string, string>();

/** A body's text to search, lower-cased: as written and as shown. */
function bodyText(body: string): string {
  let text = searched.get(body);
  if (text === undefined) {
    const blocks = readBlocks(body);
    text = `${body}\n${blocks.map((b) => b.shown).join("\n")}`.toLowerCase();
    if (searched.size > 256) searched.clear();
    searched.set(body, text);
  }
  return text;
}

function trimmed(span: MatchSpan): MatchSpan {
  const head = span.before.length > BEFORE ? `…${span.before.slice(-BEFORE).replace(/^\S*\s/, "")}` : span.before;
  const tail = span.after.length > AFTER ? `${span.after.slice(0, AFTER).replace(/\s\S*$/, "")}…` : span.after;
  return { before: head, match: span.match, after: tail };
}

const same = (a: string, b: string) => a.replace(/\s+/g, " ").trim().toLowerCase() === b.replace(/\s+/g, " ").trim().toLowerCase();

/** The first block of the page's body that holds the query, with the section heading above it;
 *  else its summary; `null` where only the title holds it. The page's own heading — a first line
 *  that is an `#` heading, or any heading repeating the title — is never a section, and is a match
 *  only where the title shown above it does not already hold the words. A block whose words hold
 *  the query only inside markup (a link's address) is shown as written. */
export function matchExcerpt(
  doc: { title: string; body: string; summary?: string | null },
  query: string,
): MatchExcerpt | null {
  const title = plainText(doc.title);
  const titleHolds = splitAtMatch(title, query) !== null;
  let section: string | null = null;
  const blocks = readBlocks(doc.body);
  for (const [i, block] of blocks.entries()) {
    const span = () => splitAtMatch(block.shown, query) ?? splitAtMatch(block.raw, query);
    if (block.kind !== "heading") {
      const found = span();
      if (found) return { heading: section, ...trimmed(found) };
      continue;
    }
    const own = (i === 0 && block.level === 1) || same(block.shown, title);
    if (own) section = null;
    if (own && titleHolds) continue;
    const found = span();
    if (found) return { heading: null, ...trimmed(found) };
    if (!own && block.level <= 3) section = block.shown;
  }
  const inSummary = splitAtMatch(doc.summary ?? "", query);
  return inSummary ? { heading: null, ...trimmed(inSummary) } : null;
}

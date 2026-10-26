// The tab title has two writers, the page and the bell, so neither writes `document.title` whole.
import { useEffect } from "react";

const BASE_TITLE = "Forge";

let pageSubject: string | null = null;
let openCount = 0;
/** A surface with its own title scheme names the tab whole, over any subject. */
let wholeTitle: string | null = null;

const wanted = () => wholeTitle ?? documentTitle(pageSubject, openCount);

/** A count as the bell and the tab show it: at most three characters (ISS-1229 r43). */
export function shortCount(count: number): string {
  return count > 99 ? "99+" : String(count);
}

/** `(3) This issue is not in Desk · Forge`. */
export function documentTitle(subject: string | null, count: number): string {
  const prefix = count > 0 ? `(${shortCount(count)}) ` : "";
  return `${prefix}${subject ? `${subject} · ` : ""}${BASE_TITLE}`;
}

let guard: MutationObserver | null = null;

/** Next writes its metadata `<title>` when a streamed head commits, after any effect; the composed title is put back. */
function apply(): void {
  if (typeof document === "undefined") return;
  const title = wanted();
  if (document.title !== title) document.title = title;
  if (guard || typeof MutationObserver === "undefined") return;
  guard = new MutationObserver(() => {
    const title = wanted();
    if (document.title !== title) document.title = title;
  });
  guard.observe(document.head, { childList: true, subtree: true, characterData: true });
}

export function setTitleCount(count: number): void {
  openCount = count;
  apply();
}

/** What the page shows, named in the tab while it is mounted. */
export function usePageTitle(subject: string | null): void {
  useEffect(() => {
    pageSubject = subject;
    apply();
    return () => {
      if (pageSubject !== subject) return;
      pageSubject = null;
      apply();
    };
  }, [subject]);
}

/** The tab says `title` as it is while the surface is mounted (the public docs' `X — Forge documentation`). */
export function useWholeTitle(title: string): void {
  useEffect(() => {
    wholeTitle = title;
    apply();
    return () => {
      if (wholeTitle !== title) return;
      wholeTitle = null;
      apply();
    };
  }, [title]);
}

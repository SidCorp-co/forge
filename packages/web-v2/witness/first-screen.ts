// The words a person reads on a page's first screen (REQ-43 BC-3): every word drawn inside the
// window, inside the page column (the top bar the page portals its header into, and the page
// under it), and seen. A word folded away, hidden, drawn off the window or scrolled below its
// bottom edge is not on the first screen and is not counted.

/** Out of the layout, folded away (a closed <details>), hidden, or drawn too small to read. */
function unseen(el: Element): boolean {
  const r = el.getBoundingClientRect();
  if (r.width <= 1 || r.height <= 1) return true;
  if (!el.checkVisibility({ contentVisibilityAuto: true, visibilityProperty: true, opacityProperty: true })) return true;
  return el.closest("[aria-hidden='true'],[hidden],.sr-only") !== null;
}

/** A word is a run of letters or digits, with the joins a word keeps inside it (it's, ISS-496, 0.4.0). */
const WORD = /[\p{L}\p{N}]+(?:['’.\-/:][\p{L}\p{N}]+)*/gu;

interface FirstScreen {
  count: number;
  words: string[];
}

export function firstScreenWords(column: HTMLElement): FirstScreen {
  const bounds = column.getBoundingClientRect();
  const bottom = Math.min(window.innerHeight, bounds.bottom);
  const right = Math.min(window.innerWidth, bounds.right);
  const words: string[] = [];
  const walker = document.createTreeWalker(column, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const el = n.parentElement;
    if (!el || unseen(el)) continue;
    for (const m of (n.textContent ?? "").matchAll(WORD)) {
      range.setStart(n, m.index);
      range.setEnd(n, m.index + m[0].length);
      const box = [...range.getClientRects()].find((r) => r.width > 0 && r.height > 0);
      if (!box) continue;
      if (box.top >= bottom || box.bottom <= Math.max(0, bounds.top) || box.left >= right || box.right <= bounds.left) continue;
      // a word inside a scroller is clipped by it: drawn past the scroller's edge, it is not seen
      if (clippedAway(el, box)) continue;
      words.push(m[0]);
    }
  }
  return { count: words.length, words };
}

function clippedAway(el: HTMLElement, box: DOMRect): boolean {
  for (let a: HTMLElement | null = el; a; a = a.parentElement) {
    const s = getComputedStyle(a);
    if (s.overflowX === "visible" && s.overflowY === "visible") continue;
    const r = a.getBoundingClientRect();
    if (box.top >= r.bottom || box.bottom <= r.top || box.left >= r.right || box.right <= r.left) return true;
  }
  return false;
}

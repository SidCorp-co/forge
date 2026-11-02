// What a screen shows on its face (REQ-11 BC-18, BC-19): the words a person reads without hovering,
// opening or focusing anything. A tooltip (`title`), an aria label and a folded or hidden element are
// not the face; text in the document is.

/** An issue, requirement, feedback or criterion key, a run code or a sha-shaped hex run: never primary text. */
const RAW_KEY = /\b(?:ISS|REQ|FB|BC)-\d+\b|\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/g;

const hidden = (el: Element | null) => el?.closest("[aria-hidden='true'],[hidden],.sr-only,details:not([open]) > :not(summary)") != null;

/** The text nodes a person reads on the face, each with its element. */
function faceTexts(root: Element): { text: string; el: Element }[] {
  const out: { text: string; el: Element }[] = [];
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const el = n.parentElement;
    if (!el || hidden(el) || el.closest("script,style")) continue;
    const text = n.textContent ?? "";
    if (text.trim()) out.push({ text, el });
  }
  return out;
}

/** Every raw identifier drawn as text on the face, with the words around it, so a failure names where. */
export function rawKeysOnFace(root: Element): string[] {
  return faceTexts(root).flatMap(({ text }) => [...text.matchAll(RAW_KEY)].map((m) => `"${m[0]}" in "${text.trim().slice(0, 60)}"`));
}

const WORD = /[\p{L}\p{N}]+(?:['’.\-/:][\p{L}\p{N}]+)*/gu;

/** The words on the face: jsdom lays nothing out, so this is the whole screen, an upper bound on its first view. */
export function faceWords(root: Element): number {
  return faceTexts(root).reduce((n, { text }) => n + [...text.matchAll(WORD)].length, 0);
}

/** Paragraphs drawn always visible: the explanation BC-18 moves into a tooltip, popover or drilldown. */
export function paragraphsOnFace(root: Element): string[] {
  return [...root.querySelectorAll("p")].filter((p) => !hidden(p) && (p.textContent ?? "").trim().split(/\s+/).length > 12).map((p) => (p.textContent ?? "").trim().slice(0, 80));
}

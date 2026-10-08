import { SAID_ENTRIES } from "@forge/contracts/said";
import { PRODUCT_STRINGS } from "@/lib/i18n/product-copy";

// What a screen drawn in any interface language shows that no reader can read: a copy key spelled as
// it is stored (a reader never given its words), the marker `said` draws for a key this build lacks,
// or a label left blank. Which language the words are in is not asked: Forge is not multilingual (the
// owner's ruling of 2026-10-08), so a key with no vi word reads its English on a vi page.

const KEYS = new Set([...Object.values(PRODUCT_STRINGS).flatMap((words) => Object.keys(words)), ...Object.keys(SAID_ENTRIES)]);
const LABELS = ["aria-label", "title", "placeholder"] as const;

/** The copy key `text` is, as it is stored, or the unknown-key marker it carries; null when neither. */
function rawIn(text: string): string | null {
  const bare = text.trim();
  if (bare.includes("⟦")) return `a key this build lacks, "${bare}"`;
  return KEYS.has(bare) ? `the raw copy key "${bare}"` : null;
}

/** What `root` shows that cannot be read, named; null when every word and label reads. */
export function unreadIn(root: HTMLElement): string | null {
  const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    // text marked `translate="no"` is an identifier the page names on purpose (a permission, a scope)
    if (n.parentElement?.closest('[translate="no"]')) continue;
    const hit = rawIn(n.textContent ?? "");
    if (hit) return hit;
  }
  for (const el of root.querySelectorAll(LABELS.map((a) => `[${a}]`).join(","))) {
    for (const a of LABELS) {
      const v = el.getAttribute(a);
      if (v === null) continue;
      if (!v.trim()) return `a blank ${a} on <${el.tagName.toLowerCase()}>`;
      const hit = el.closest('[translate="no"]') ? null : rawIn(v);
      if (hit) return `${hit} (${a})`;
    }
  }
  for (const el of root.querySelectorAll("[data-fact-label]")) {
    if (!el.textContent?.trim()) return "a blank fact label";
  }
  return null;
}

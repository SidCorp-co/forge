// REQ-43 r3 BC-17 (owner, 2026-11-10): a record page's long text opens in a side drawer or a hover
// card, never in place. A control that unfolds under itself is a `<details>` or a button that says it
// expands while naming no popup it opens; one inside an open dialog is the drawer's own business.

/** Each control on `root`'s face that would unfold its body in place, named by its test id or text. */
export function unfoldsInPlace(root: HTMLElement): string[] {
  const face = (el: Element) => el.closest("[role=dialog]") === null;
  const name = (el: Element) => el.closest("[data-testid]")?.getAttribute("data-testid") ?? (el.textContent ?? "").trim().slice(0, 40);
  const details = [...root.querySelectorAll("details")].filter(face).map((d) => `<details> ${name(d)}`);
  const toggles = [...root.querySelectorAll("[aria-expanded]")]
    .filter((el) => face(el) && !el.hasAttribute("aria-haspopup") && el.getAttribute("role") !== "combobox")
    .map((el) => `toggle ${name(el)}`);
  return [...details, ...toggles];
}

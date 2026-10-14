// The owner's flat-settings rule as two reads: the class lists a source writes, and the classes a
// rendered element carries. A flat page rules its sections with one hairline and has no boxes.

export function classLists(source: string): string[] {
  return [...source.matchAll(/"([^"\n]*)"|`([^`]*)`/g)].map((m) => m[1] ?? m[2] ?? "");
}

/** All four sides bordered, or rounded and filled and padded. Pills, fixed-size and inline controls and code readouts are not containers. */
export function boxedContainer(classes: string): boolean {
  const t = classes.split(/\s+/).filter(Boolean);
  const rounded = t.some((x) => /^rounded-(sm|md|lg|xl|2xl)$/.test(x));
  const bordered = t.includes("border");
  const filled = t.some((x) => /^bg-(surface|sunken)/.test(x)) && t.some((x) => /^p[xy]?-/.test(x));
  const control = t.some((x) => /^h-\d+$/.test(x)) && t.some((x) => /^w-\d+$/.test(x));
  const exempt = control || t.includes("rounded-pill") || t.includes("inline-flex") || t.includes("font-mono");
  return (bordered || (rounded && filled)) && !exempt;
}

/** Boxed containers in a rendered tree. Controls, announced status and a Banner (which colours its own border inline) are not containers. */
export function boxedInTree(root: Element): string[] {
  const CONTROLS = new Set(["INPUT", "TEXTAREA", "SELECT", "BUTTON", "A"]);
  return [root, ...root.querySelectorAll("*")]
    .filter((el) => !CONTROLS.has(el.tagName) && el.getAttribute("role") !== "alert" && el.getAttribute("role") !== "status")
    .filter((el) => !(el.getAttribute("style") ?? "").includes("border-color"))
    .map((el) => el.getAttribute("class") ?? "")
    .filter(boxedContainer);
}

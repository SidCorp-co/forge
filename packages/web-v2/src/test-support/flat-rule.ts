// The owner's rule for a settings page, as two reads: the class lists a source file writes, and the
// class list an element carries once rendered. A flat page rules its sections with a hairline on one
// side and takes its hierarchy from type and whitespace, so a container drawn as a box fails both.

/** Every class list in a source file: each string literal that could hold one. */
export function classLists(source: string): string[] {
  return [...source.matchAll(/"([^"\n]*)"|`([^`]*)`/g)].map((m) => m[1] ?? m[2] ?? "");
}

/**
 * A container drawn as a box: all four sides bordered, or rounded and filled and padded. A pill, a
 * fixed-size control, an inline control such as a segmented switch and a code readout are not containers.
 */
export function boxedContainer(classes: string): boolean {
  const t = classes.split(/\s+/).filter(Boolean);
  const rounded = t.some((x) => /^rounded-(sm|md|lg|xl|2xl)$/.test(x));
  const bordered = t.includes("border");
  const filled = t.some((x) => /^bg-(surface|sunken)/.test(x)) && t.some((x) => /^p[xy]?-/.test(x));
  const control = t.some((x) => /^h-\d+$/.test(x)) && t.some((x) => /^w-\d+$/.test(x));
  const exempt = control || t.includes("rounded-pill") || t.includes("inline-flex") || t.includes("font-mono");
  return (bordered || (rounded && filled)) && !exempt;
}

/**
 * The boxed containers in a rendered tree, by the classes they carry. The form controls a person
 * types into or presses are the design system's own and are not containers; a notice is a toned
 * message (a Banner colours its own border inline) and a status or alert is announced, not laid out.
 */
export function boxedInTree(root: Element): string[] {
  const CONTROLS = new Set(["INPUT", "TEXTAREA", "SELECT", "BUTTON", "A"]);
  return [root, ...root.querySelectorAll("*")]
    .filter((el) => !CONTROLS.has(el.tagName) && el.getAttribute("role") !== "alert" && el.getAttribute("role") !== "status")
    .filter((el) => !(el.getAttribute("style") ?? "").includes("border-color"))
    .map((el) => el.getAttribute("class") ?? "")
    .filter(boxedContainer);
}

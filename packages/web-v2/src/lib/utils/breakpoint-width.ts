/**
 * The width the page's breakpoints read for `el` (app/globals.css): the nearest container named
 * `page`, which is the page column while the Ask Agent panel stands beside it and `body`, the window,
 * otherwise. Code that mirrors a breakpoint in JavaScript reads this, never `window.innerWidth`, or it
 * disagrees with the layout whenever the panel is beside the page. With no such container (no
 * stylesheet, as under jsdom) it is the window.
 */
export function breakpointWidth(el: Element): number {
  for (let at: Element | null = el; at; at = at.parentElement) {
    const names = getComputedStyle(at).containerName ?? "";
    if (names.split(/\s+/).includes("page")) return at.getBoundingClientRect().width;
  }
  return window.innerWidth;
}

// Lays a section's markup out in a real Chrome at a given viewport and reads back what the page
// looks like: the box each section is drawn in, from computed style. jsdom has no cascade over the
// app's stylesheet, so "this section carries no card" can only be shown where the stylesheet is
// applied; a class list says what was asked for, never what was drawn.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appStylesheet, warmChrome } from "./chrome-layout";

export interface DrawnBox {
  /** `aria-label` of the section, or the tag when it has none. */
  label: string;
  borderTop: number;
  borderRight: number;
  borderBottom: number;
  borderLeft: number;
  radius: string;
  shadow: string;
  /** Computed background, so a transparent fill reads as alpha 0. */
  background: string;
  paddingLeft: string;
  paddingRight: string;
  /** Left edge of the section against the column it sits in, in px. */
  inset: number;
  /** Width of the section against the column it sits in, in px. */
  width: number;
  headingFont: string;
}

export interface Drawn {
  viewport: number;
  sections: DrawnBox[];
  /** Descendants other than controls and announced status that are drawn as a box: bordered on all four sides, or rounded over a fill. */
  boxed: string[];
  /** The page scrolled sideways, which a section too wide for a phone does. */
  scrollsSideways: boolean;
}

const MEASURE = `
(function () {
  function box(el) {
    var cs = getComputedStyle(el);
    var col = el.parentElement.getBoundingClientRect();
    var r = el.getBoundingClientRect();
    var h = el.querySelector("h2");
    var hs = h ? getComputedStyle(h) : null;
    return {
      label: el.getAttribute("aria-label") || el.tagName,
      borderTop: cs.borderTopStyle === "none" ? 0 : parseFloat(cs.borderTopWidth),
      borderRight: cs.borderRightStyle === "none" ? 0 : parseFloat(cs.borderRightWidth),
      borderBottom: cs.borderBottomStyle === "none" ? 0 : parseFloat(cs.borderBottomWidth),
      borderLeft: cs.borderLeftStyle === "none" ? 0 : parseFloat(cs.borderLeftWidth),
      radius: cs.borderTopLeftRadius,
      shadow: cs.boxShadow,
      background: cs.backgroundColor,
      paddingLeft: cs.paddingLeft,
      paddingRight: cs.paddingRight,
      inset: Math.round((r.left - col.left) * 10) / 10,
      width: Math.round(r.width * 10) / 10,
      headingFont: hs ? hs.fontSize + "/" + hs.fontWeight + "/" + hs.textTransform : ""
    };
  }
  function visible(s, w) { return s !== "none" && parseFloat(w) > 0; }
  function filled(c) { return c !== "transparent" && !/rgba\\([^)]*[, \\/]\\s*0\\)$/.test(c); }
  var CONTROLS = "input,textarea,select,button,a,code,pre,svg,img";
  var root = document.getElementById("col");
  var sections = Array.prototype.map.call(root.querySelectorAll(":scope > section"), box);
  var boxed = [];
  Array.prototype.forEach.call(root.querySelectorAll("*"), function (el) {
    if (el.closest(CONTROLS)) return;
    var role = el.getAttribute("role");
    if (role === "status" || role === "alert") return;
    var cs = getComputedStyle(el);
    var all4 = ["Top", "Right", "Bottom", "Left"].every(function (s) { return visible(cs["border" + s + "Style"], cs["border" + s + "Width"]); });
    var rounded = parseFloat(cs.borderTopLeftRadius) > 0 && filled(cs.backgroundColor);
    if (all4 || rounded) boxed.push(el.tagName.toLowerCase() + "." + (el.getAttribute("class") || ""));
  });
  var doc = document.documentElement;
  return { viewport: window.innerWidth, sections: sections, boxed: boxed, scrollsSideways: doc.scrollWidth > doc.clientWidth + 1 };
})()`;

/**
 * Lays `markup` out inside a column (`#col`) with a 16px gutter, in a frame `viewport` px wide (a frame
 * is its own viewport, so the responsive utilities answer for that screen), and returns what `measure`,
 * an expression run in the frame once it is laid out, evaluates to.
 */
export async function measuredAt<T extends { viewport: number }>(markup: string, viewport: number, measure: string): Promise<T> {
  const chrome = await warmChrome();
  const css = await appStylesheet();
  const inner = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><style>${css}</style></head><body style="margin:0"><div id="col" style="padding:0 16px">${markup}</div><script>parent.postMessage(btoa(unescape(encodeURIComponent(JSON.stringify(${measure})))), "*");</script></body></html>`;
  const outer = `<!doctype html><html><body style="margin:0"><iframe src="inner.html" style="width:${viewport}px;height:1200px;border:0"></iframe><pre id="drawn"></pre><script>addEventListener("message", function (e) { document.getElementById("drawn").textContent = e.data; });</script></body></html>`;
  const dir = mkdtempSync(join(tmpdir(), "forge-chrome-flat-"));
  try {
    writeFileSync(join(dir, "inner.html"), inner);
    writeFileSync(join(dir, "outer.html"), outer);
    const body = await chrome.evaluateWhenReady(`file://${join(dir, "outer.html")}`, 'document.getElementById("drawn")?.textContent ?? ""', 20_000);
    if (!body) throw new Error("Chrome laid the page out but reported nothing: the frame's script did not run.");
    const measured = JSON.parse(Buffer.from(body, "base64").toString("utf8")) as T;
    if (measured.viewport !== viewport) {
      throw new Error(`Chrome laid the page out in a ${measured.viewport}px viewport, not the ${viewport}px asked for, so the responsive classes answered for another screen.`);
    }
    return measured;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function drawnAt(markup: string, viewport: number): Promise<Drawn> {
  return measuredAt<Drawn>(markup, viewport, MEASURE);
}

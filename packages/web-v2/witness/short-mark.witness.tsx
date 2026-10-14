// A short's mark on the Criteria tab, witnessed at desktop and phone width in both themes
// (forge-core-eb's ruling of 2026-10-14): a short is the ✓ drawn hollow in the warn tone, its glyph at
// 3:1 or more on the page and its word Short at 4.5:1 or more, the word shown from md up and the glyph
// alone on a phone. Pass, fail, skipped and not-judged keep their marks. jsdom computes no colour and
// lays nothing out, so the contrast and the word's width are measured here.
//
//   pnpm --filter web-v2 witness witness/short-mark.witness.tsx --out <dir>

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { IssueCriteria } from "@/features/issues/components/issue-criteria";
import type { IssueDetail } from "@/features/issues/types";
import "./entry";
import { InRouter } from "./router";

const AT = "2026-10-14T09:12:00.000Z";
const judged = (verdict: "pass" | "short" | "fail" | "skipped", reason: string) => ({
  verdict,
  reason,
  identityKind: "commit",
  commitSha: "8e0e7dae6".padEnd(40, "0"),
  authorAgency: "agent",
  createdAt: AT,
});
const criteria = [
  { id: "k1", n: 1, statement: "A design-only issue is refused at awaiting_release", position: 0, requirementCriterionId: null, latest: judged("pass", "refused MERGE_DESIGN_ONLY") },
  { id: "k2", n: 2, statement: "The refusal points at the design_delivered close", position: 1, requirementCriterionId: null, latest: judged("short", "points there; the guide row still says git only") },
  { id: "k3", n: 3, statement: "A person's hand-back to open carries its reason", position: 2, requirementCriterionId: null, latest: judged("fail", "moved with no reason posted") },
  { id: "k4", n: 4, statement: "The roster lists a design-only issue outside git", position: 3, requirementCriterionId: null, latest: judged("skipped", "no roster on this project") },
  { id: "k5", n: 5, statement: "The tally counts a short as met", position: 4, requirementCriterionId: null, latest: null },
];

window.fetch = async (input: RequestInfo | URL) =>
  String(input).includes("/issues/witness/criteria")
    ? new Response(JSON.stringify({ criteria }), { status: 200, headers: { "content-type": "application/json" } })
    : new Response("{}", { status: 404, headers: { "content-type": "application/json" } });

const root = document.getElementById("root");
if (!root) throw new Error("the page has no #root");
createRoot(root).render(
  <InRouter>
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <div className="mx-auto max-w-3xl space-y-3 p-4">
        <IssueCriteria issue={{ id: "witness", status: "in_progress" } as IssueDetail} projectId="p1" checklist={[]} canWrite={false} requirementKey={null} />
        <p className="text-12 text-subtle" data-witness="measured" />
      </div>
    </QueryClientProvider>
  </InRouter>,
);

const mark = (n: number) => document.querySelector<HTMLElement>(`[data-testid=criterion-${n}-verdict]`);
const word = (n: number) => document.querySelector<HTMLElement>(`[data-testid=criterion-${n}-word]`);

/** A CSS colour as sRGB, read back from a canvas pixel, so an oklch() token is measured as drawn. */
function rgbOf(css: string): [number, number, number] {
  const g = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  if (!g) throw new Error("no 2d canvas");
  g.fillStyle = css;
  g.fillRect(0, 0, 1, 1);
  const [r = 0, gr = 0, b = 0] = g.getImageData(0, 0, 1, 1).data;
  return [r, gr, b];
}
const lum = (rgb: [number, number, number]) => {
  const [r = 0, g = 0, b = 0] = rgb.map((v) => ((v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (fg: string, bg: string) => {
  const [hi = 0, lo = 0] = [lum(rgbOf(fg)), lum(rgbOf(bg))].sort((p, q) => q - p);
  return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
};

function inTheme(theme: "light" | "dark") {
  return () => {
    document.documentElement.dataset.theme = theme;
    const wrong: string[] = [];
    const short = mark(2);
    const pass = mark(1);
    if (!short || !pass) return ["the pass or short row is not drawn"];
    if ([3, 4, 5].some((n) => !mark(n))) wrong.push("a fail, skipped or not-judged row is not drawn");
    if (!short.querySelector("svg[data-mark=hollow]")) wrong.push("the short's mark is not the hollow ✓");
    if (pass.querySelector("svg[data-mark=hollow]") || pass.textContent !== "✓") wrong.push("the pass's mark is not the solid ✓");
    const bg = getComputedStyle(document.body).backgroundColor;
    const glyph = ratio(getComputedStyle(short).color, bg);
    const passGlyph = ratio(getComputedStyle(pass).color, bg);
    if (getComputedStyle(short).color === getComputedStyle(pass).color) wrong.push("the short's mark has the pass's colour");
    if (glyph < 3) wrong.push(`the short's glyph reads ${glyph}:1 on the page, under 3:1`);
    const w = word(2);
    const desktop = window.innerWidth >= 768;
    const shown = Boolean(w && w.getBoundingClientRect().width > 0);
    if (desktop && !shown) wrong.push("the word Short is not shown in the row at md and up");
    if (!desktop && shown) wrong.push("the word Short takes the phone's row");
    const text = w ? ratio(getComputedStyle(w).color, bg) : 0;
    if (desktop && text < 4.5) wrong.push(`the word Short reads ${text}:1 on the page, under 4.5:1`);
    if (short.getAttribute("aria-label") !== "Short") wrong.push(`the short's mark is named "${short.getAttribute("aria-label")}", not Short`);
    const measured = document.querySelector("[data-witness=measured]");
    if (measured) measured.textContent = `${theme} · ${window.innerWidth} px — short glyph ${glyph}:1, word ${desktop ? `${text}:1` : "hidden"}; pass glyph ${passGlyph}:1`;
    return wrong;
  };
}

window.__witness = {
  cases: [
    { name: "desktop-1440", width: 1440 },
    { name: "phone-390", width: 390 },
  ],
  ready: () => Boolean(mark(5)),
  stages: [
    { name: "light", run: inTheme("light") },
    { name: "dark", run: inTheme("dark") },
  ],
};

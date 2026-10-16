// A visitor's status link page, at desktop and phone width in light and dark: the title, core's one
// sentence and the phases reached, with nothing scrolling sideways and the sentence at 4.5:1 or more
// on the page.
//
//   pnpm --filter web-v2 witness witness/widget-status.witness.tsx --out <dir>

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { WidgetStatusPage } from "@/features/widget";
import "./entry";

const TOKEN = `fw_stat_${"z".repeat(43)}`;

window.fetch = () =>
  Promise.resolve(
    new Response(
      JSON.stringify({
        feedbackKey: "FB-31",
        title: "Pay button on the cart does nothing",
        phase: "in_progress",
        says: "We found the cause and a fix is being made now.",
        filedAt: "2026-10-14T09:00:00.000Z",
        updatedAt: new Date(Date.now() - 3 * 3600_000).toISOString(),
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    ),
  );

const root = document.getElementById("root");
if (!root) throw new Error("the page has no #root");
createRoot(root).render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <WidgetStatusPage token={TOKEN} />
  </QueryClientProvider>,
);

const width = () => (window.innerWidth >= 1024 ? window.innerWidth : screen.width);

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

function inTheme(theme: "light" | "dark") {
  return () => {
    document.documentElement.dataset.theme = theme;
    const wrong: string[] = [];
    if (document.documentElement.scrollWidth > width()) wrong.push(`the page scrolls sideways: ${document.documentElement.scrollWidth} px in ${width()}`);
    const says = document.querySelector<HTMLElement>("[data-testid=widget-status-says]");
    const page = document.querySelector<HTMLElement>(".min-h-dvh");
    if (!says || !page) return ["the status is not drawn"];
    const [hi = 0, lo = 0] = [lum(rgbOf(getComputedStyle(says).color)), lum(rgbOf(getComputedStyle(page).backgroundColor))].sort((p, q) => q - p);
    const read = Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
    if (read < 4.5) wrong.push(`the sentence reads ${read}:1 on the page, under 4.5:1`);
    if (document.querySelectorAll("[data-testid=widget-status-steps] [data-done]").length !== 3) wrong.push("not three phases are marked reached");
    return wrong;
  };
}

window.__witness = {
  cases: [
    { name: "desktop-1440", width: 1440 },
    { name: "phone-390", width: 390 },
  ],
  ready: () => Boolean(document.querySelector("[data-testid=widget-status]")),
  stages: [
    { name: "light", run: inTheme("light") },
    { name: "dark", run: inTheme("dark") },
  ],
};

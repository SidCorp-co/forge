// An attached image whose file does not load, as a person meets it: the feedback peek's evidence
// tile, an attachment list, and the lightbox opened on it. The page is file:// and reaches no core, so
// every attachment here fails to load as a missing file would. Light at 1440, dark at 390 (the peek
// is the full-screen sheet there). Each stage reads that every failed image is the box naming its
// file, and that no broken <img> is left standing; the lightbox's header reads white in either theme.
//
//   pnpm --filter web-v2 witness witness/shot-fallback.witness.tsx --out <dir>

import { Component, type ReactNode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { TopBarSlotProvider } from "@/design";
import { AttachmentList } from "@/features/attachments";
import { FeedbackScreen } from "@/features/feedback/components/feedback-screen";
import { ShellTopBar } from "@/features/shell/components/shell-top-bar";
import { notifyLocationChange } from "@/lib/utils/use-location-search";
import { FEEDBACK_SEED, ITEM, P } from "@/test/vi-chrome-feedback";
import { Seeded } from "@/test/vi-chrome-requirements";
import "./entry";
import { InRouter } from "./router";

// a read no fixture seeded stays in flight, as in the vi walking test
window.fetch = () => new Promise<Response>(() => {});

const AT = "2026-10-15T08:00:00.000Z";
const FILES = [
  { id: "f1", name: "checkout-step-2.png", mime: "image/png", size: 182_400, url: "/api/projects/p1/attachments/f1", createdAt: AT },
  { id: "f2", name: "cart-total-wrong.png", mime: "image/png", size: 96_100, url: "/api/projects/p1/attachments/f2", createdAt: AT },
  { id: "f3", name: "console-log.txt", mime: "text/plain", size: 2_048, url: "/api/projects/p1/attachments/f3", createdAt: AT },
];

const PAGES = [
  { name: "feedback-peek", draw: () => <Seeded data={FEEDBACK_SEED}><FeedbackScreen projectId={P} slug="hop" /></Seeded> },
  {
    name: "attachments",
    draw: () => (
      <div className="mx-auto grid max-w-3xl gap-3 p-6">
        <h2 className="text-16 font-bold text-accent-text">Files</h2>
        <AttachmentList rows={FILES} />
      </div>
    ),
  },
] as const;

const at: { show: (i: number) => void } = { show: () => {} };

class Caught extends Component<{ children: ReactNode }, { error: string | null }> {
  state = { error: null as string | null };
  static getDerivedStateFromError(e: unknown) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
  render() {
    return this.state.error ? <p data-witness="threw">{this.state.error}</p> : this.props.children;
  }
}

function Shell() {
  const [page, setPage] = useState(0);
  useEffect(() => {
    at.show = setPage;
  });
  const p = PAGES[page] ?? PAGES[0];
  return (
    <InRouter key={p.name} at="/projects/hop/feedback" pattern="/projects/$slug/$">
      <TopBarSlotProvider>
        <div className="flex h-dvh overflow-hidden bg-app" data-shell>
          <div className="hidden h-full flex-none border-r border-line bg-surface md:block" style={{ width: 88 }} />
          <div className="flex min-w-0 flex-1 flex-col" data-witness="page">
            <ShellTopBar chatOpen={false} onToggleChat={() => {}} />
            <main className="min-h-0 flex-1 overflow-y-auto">
              <Caught key={p.name}>{p.draw()}</Caught>
            </main>
          </div>
        </div>
      </TopBarSlotProvider>
    </InRouter>
  );
}

const q = (sel: string) => document.querySelector<HTMLElement>(sel);
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Light on the desktop case, dark on the phone one. */
const theme = () => {
  document.documentElement.dataset.theme = window.innerWidth < 500 ? "dark" : "light";
};

/** A CSS colour as sRGB, read back from a canvas pixel, so an oklch() token is measured as drawn. */
function rgbOf(css: string): [number, number, number] {
  const g = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  if (!g) throw new Error("no 2d canvas");
  g.fillStyle = css;
  g.fillRect(0, 0, 1, 1);
  const [r = 0, gr = 0, b = 0] = g.getImageData(0, 0, 1, 1).data;
  return [r, gr, b];
}

/** What is wrong with the failed images under `root`: a broken <img> still standing, or a box without its file's name. */
function failedImages(root: ParentNode, where: string, names: string[]): string[] {
  const wrong: string[] = [];
  const standing = [...root.querySelectorAll("img")].filter((img) => img.complete && img.naturalWidth === 0);
  if (standing.length) wrong.push(`${where}: ${standing.length} broken image(s) still drawn`);
  for (const name of names) {
    if (!root.querySelector(`[data-testid=attached-image-failed][aria-label="Couldn't load ${name}"]`)) wrong.push(`${where}: no box names ${name}`);
  }
  return wrong;
}

window.__witness = {
  cases: [
    { name: "wide-1440-light", width: 1440 },
    { name: "phone-390-dark", width: 390 },
  ],
  ready: () => Boolean(q("[data-witness=page]")),
  stages: [
    {
      name: "feedback-peek",
      run: async () => {
        theme();
        window.history.replaceState(null, "", window.location.pathname);
        at.show(0);
        await pause(400);
        window.history.replaceState(null, "", `${window.location.pathname}?peek=${ITEM.key}`);
        notifyLocationChange();
        await pause(1200);
        if (q("[data-witness=threw]")) return [`the feedback list threw: ${q("[data-witness=threw]")?.innerText}`];
        const evidence = q("[data-testid=feedback-peek-evidence]");
        if (!evidence) return ["the feedback peek drew no evidence section"];
        evidence.scrollIntoView({ block: "center" });
        await pause(200);
        return failedImages(evidence, "the peek's evidence", ITEM.attachments.map((a) => a.name));
      },
    },
    {
      name: "attachments",
      run: async () => {
        theme();
        at.show(1);
        await pause(1200);
        return failedImages(document, "the attachment list", ["checkout-step-2.png", "cart-total-wrong.png"]);
      },
    },
    {
      name: "lightbox",
      run: async () => {
        theme();
        const tile = document.querySelector<HTMLElement>("ul button");
        if (!tile) return ["the attachment list drew no image tile to open"];
        tile.click();
        await pause(1200);
        const dialog = q("[role=dialog]");
        if (!dialog) return ["the lightbox did not open"];
        const wrong = failedImages(dialog, "the lightbox", ["checkout-step-2.png", "cart-total-wrong.png"]);
        // the header is drawn over the dark backdrop in either theme: its name and acts read white
        for (const el of dialog.querySelectorAll<HTMLElement>("header span[title], header button")) {
          const [r, g, b] = rgbOf(getComputedStyle(el).color);
          if (Math.min(r, g, b) < 150) wrong.push(`the lightbox header's "${el.innerText.trim() || el.getAttribute("aria-label")}" is drawn rgb(${r}, ${g}, ${b}) over the dark backdrop`);
        }
        return wrong;
      },
    },
  ],
};

const root = document.getElementById("root");
if (!root) throw new Error("the witness page has no #root to mount into");
createRoot(root).render(<Shell />);

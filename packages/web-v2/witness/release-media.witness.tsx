// A judge's clip on What's new and on the release page (REQ-40 BC-3), witnessed at phone and desktop
// width in both themes: the release opens on its name and summary, and its highlight plays the clip
// inline, muted, with controls, on the still QA kept beside it, inside the window.
//
// The clip is a real one, never a stand-in: put a judge's recording and its still beside the page as
// `<out>/release-clip.webm` and `<out>/release-clip.png` (what `pnpm --filter web-v2 clip` writes), then
//
//   pnpm --filter web-v2 witness witness/release-media.witness.tsx --out <dir>
//
// A clip that is not there, or that Chrome cannot play, fails the run by name.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { ReleaseHighlight } from "@forge/contracts/release-page";
import { ReleaseReader } from "@/features/releases/components/release-reader";
import { WhatsNewSheet } from "@/features/whats-new/components/whats-new-panel";
import { releaseOf, feedOf } from "@/features/whats-new/fixtures";
import { releasePage } from "@/test/release-page";
import "./entry";
import { InRouter } from "./router";

// a file:// page names a core path against the disk's root (`coreFileUrl`), so the files beside the
// page are named by their absolute path
const beside = (name: string) => new URL(name, window.location.href).pathname;
const SHA = "571963bbff5156e1e9204db4a2d17397b2bf467c";

const HIGHLIGHT: ReleaseHighlight = {
  requirement: { key: "REQ-17", title: "Workflows" },
  title: "Designs and the map, side by side",
  body: "On a phone, switch between your designs and the map with one tap.",
  claims: ["BC-29"],
  media: {
    kind: "clip",
    attachmentId: "a23b8b14-8412-4fdf-bd74-28ad89524548",
    name: "release-clip.webm",
    mime: "video/webm",
    bytes: 661109,
    verdictId: "ced87964-9e23-4f95-9e6e-0a8b43b5beb1",
    issueKey: "ISS-646",
    criterion: { n: 1, bc: "BC-29" },
    commitSha: SHA,
    url: beside("release-clip.webm"),
    poster: { attachmentId: "75b6f7db-2f75-48e6-b5e7-42e2f6040cea", name: "release-clip.png", mime: "image/png", url: beside("release-clip.png") },
  },
  mediaGap: null,
};

const NAMING = {
  name: "Workflows on any screen",
  summary: "The workflows page now fits a phone. Switch between your designs and the map without losing your place.",
};

const page = releasePage({
  header: { ...releasePage().header, version: "0.4.0-dev.290", build: SHA, ...NAMING },
  highlights: { state: "drafted", model: "m", draftedAt: "2026-10-23T04:45:00.000Z", sourceDigest: "d", highlights: [HIGHLIGHT] },
});
const feed = feedOf(
  releaseOf({
    version: "0.4.0-dev.290",
    ...NAMING,
    releasedAt: "2026-10-23T04:20:00.000Z",
    highlights: page.highlights,
    changes: [
      { kind: "new", line: "Workflows fit a phone." },
      { kind: "fixed", line: "The map no longer covers the design list." },
    ],
  }),
);

type View = "panel" | "page";
let show: (v: View) => void = () => {
  throw new Error("the witness has not mounted");
};

function Witness() {
  const [view, setView] = useState<View>("panel");
  show = setView;
  return view === "panel" ? (
    <WhatsNewSheet open onClose={() => undefined} feed={feed} failure={null} />
  ) : (
    <div className="mx-auto max-w-3xl p-4">
      <ReleaseReader page={page} authed={false} />
    </div>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("the page has no #root");
createRoot(root).render(
  <InRouter>
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <Witness />
    </QueryClientProvider>
  </InRouter>,
);

const clip = () => document.querySelector<HTMLVideoElement>("[data-testid=release-media-clip]");
const settle = (ms = 300) => new Promise((ok) => setTimeout(ok, ms));
const theme = (t: "light" | "dark") => {
  document.documentElement.dataset.theme = t;
  document.documentElement.classList.toggle("dark", t === "dark");
};

/** The clip has loaded far enough to draw, or why it has not. */
async function playable(v: HTMLVideoElement): Promise<string[]> {
  for (let i = 0; i < 50 && v.readyState < 1 && !v.error; i++) await settle(100);
  if (v.error || v.readyState < 1) return [`the clip at ${v.currentSrc || v.src} did not load: put a judge's release-clip.webm and release-clip.png beside the page`];
  const still = await new Promise<boolean>((ok) => {
    const img = new Image();
    img.onload = () => ok(img.naturalWidth > 0);
    img.onerror = () => ok(false);
    img.src = v.poster;
  });
  return still ? [] : [`the clip's still at ${v.poster} did not load`];
}

async function reads(where: "panel" | "page", t: "light" | "dark"): Promise<string[]> {
  show(where);
  theme(t);
  await settle();
  const wrong: string[] = [];
  // the release page's name is its title in the app's frame, which the reader sits under
  if (where === "panel" && !document.querySelector("[data-testid=whats-new-name]")?.textContent?.includes(NAMING.name)) wrong.push("the panel does not open on the release's name");
  if (!document.body.textContent?.includes(NAMING.summary)) wrong.push(`the ${where} does not say the release's summary`);
  const v = clip();
  if (!v) return [...wrong, `the ${where}'s highlight draws no clip`];
  if (!v.muted || !v.controls || !v.playsInline) wrong.push(`the clip is not inline, muted and with controls (muted ${v.muted}, controls ${v.controls}, inline ${v.playsInline})`);
  if (v.dataset.poster !== "kept") wrong.push(`the clip opens on its ${v.dataset.poster ?? "no"} frame, not QA's still`);
  wrong.push(...(await playable(v)));
  const box = v.getBoundingClientRect();
  if (box.width < 200) wrong.push(`the clip is drawn ${Math.round(box.width)} px wide, too small to watch`);
  if (box.right > window.innerWidth + 0.5) wrong.push(`the clip runs past the window: right edge ${Math.round(box.right)} in ${window.innerWidth}`);
  if (document.documentElement.scrollWidth > window.innerWidth) wrong.push(`the page scrolls sideways: ${document.documentElement.scrollWidth} px in ${window.innerWidth}`);
  return wrong;
}

window.__witness = {
  cases: [
    { name: "phone", width: 390 },
    { name: "desktop", width: 1440 },
  ],
  ready: () => clip() !== null,
  stages: [
    { name: "panel-light", run: () => reads("panel", "light") },
    { name: "panel-dark", run: () => reads("panel", "dark") },
    { name: "page-light", run: () => reads("page", "light") },
    { name: "page-dark", run: () => reads("page", "dark") },
  ],
};

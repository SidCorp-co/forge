// Two release pages under REQ-70, witnessed at phone and desktop width in both themes.
//
// An open release (awaiting approval) whose highlight was refused for want of a picture or clip
// (BC-2): it says it is waiting for a clip or picture from QA, with the refusal behind its fold, and
// never a "No clip" line. Its changes read as a short title and one sentence (BC-3); a note still
// owing a title or one sentence is named under Other changes until its writer fixes it.
//
// A release that shipped before the rule: it reads as it did when it ended, its highlight still
// saying it has no clip, and a note written before titles shown as its whole sentence.
//
//   pnpm --filter web-v2 witness witness/release-highlight-refused.witness.tsx --out <dir>

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { ReleasePage } from "@forge/contracts/release-page";
import { ReleaseReader } from "@/features/releases/components/release-reader";
import { releasePage, TECHNICAL } from "@/test/release-page";
import "./entry";
import { InRouter } from "./router";

const REFUSAL = "QA kept no clip or picture of any criterion 0.4.0-dev.320 proves (REQ-70 BC-2, BC-3), so no highlight can show one; the QA agent records a clip of one on this build";
const base = releasePage();

const open = releasePage({
  view: "developer",
  header: { ...base.header, state: "awaiting_approval", releasedAt: null, version: "0.4.0-dev.320", name: "Clearer release pages", summary: "Every change on a release page now reads as a short title and one sentence. Highlights wait for a clip or picture from QA." },
  highlights: { state: "failed", at: "2026-10-25T04:00:00.000Z", refusals: [{ code: "RELEASE_HIGHLIGHTS_NO_MEDIA", path: "highlights", detail: REFUSAL }] },
  improvements: [
    {
      issueKey: "ISS-693",
      kind: "improved",
      section: "Changed",
      line: "Each change in one sentence",
      detail: "Each change on a release page reads as a short title and one sentence.",
      requirementKey: "REQ-70",
    },
  ],
  fixes: [],
  withoutNotes: [
    { issueKey: "ISS-16", title: "Site sync records each run", why: "not_one_sentence" },
    { issueKey: "ISS-498", title: "Merged work stays on the release roster", why: "untitled" },
  ],
  knownIssues: [],
  technical: TECHNICAL,
});

const kept = base.highlights.state === "drafted" ? base.highlights.highlights[0] : undefined;
if (!kept) throw new Error("the fixture page has no highlight");
const ended: ReleasePage = releasePage({
  view: "developer",
  header: { ...base.header, state: "shipped", version: "0.4.0-dev.317", name: "Feedback from any page", summary: "Feedback can be sent from any page with a screenshot. A repeat joins the open report." },
  highlights: {
    state: "drafted",
    model: "m",
    draftedAt: "2026-10-24T04:00:00.000Z",
    sourceDigest: "d",
    highlights: [{ ...kept, media: null, mediaGap: "QA kept no clip or picture as evidence of BC-1 on this build" }],
  },
  improvements: [
    {
      issueKey: "ISS-480",
      kind: "improved",
      section: "Changed",
      line: "A release page opens on what changed for you, then what it proves.",
      detail: null,
      requirementKey: null,
    },
  ],
  fixes: [],
  withoutNotes: [],
  knownIssues: [],
  technical: TECHNICAL,
});

type View = "open" | "ended";
let show: (v: View) => void = () => {
  throw new Error("the witness has not mounted");
};

function Witness() {
  const [view, setView] = useState<View>("open");
  show = setView;
  return (
    <div className="mx-auto max-w-3xl p-4">
      <ReleaseReader key={view} page={view === "open" ? open : ended} slug="forge" authed={false} />
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

const settle = (ms = 300) => new Promise((ok) => setTimeout(ok, ms));
const theme = (t: "light" | "dark") => {
  document.documentElement.dataset.theme = t;
  document.documentElement.classList.toggle("dark", t === "dark");
};
const byTest = (id: string) => document.querySelector<HTMLElement>(`[data-testid=${id}]`);
const sideways = () =>
  document.documentElement.scrollWidth > window.innerWidth ? [`the page scrolls sideways: ${document.documentElement.scrollWidth} px in ${window.innerWidth}`] : [];

async function readsOpen(t: "light" | "dark"): Promise<string[]> {
  show("open");
  theme(t);
  await settle();
  const wrong: string[] = [];
  const failed = byTest("page-highlights-failed");
  if (!failed) return ["the open release draws no refused highlights line"];
  if (failed.dataset.why !== "no-media") wrong.push(`the refused line reads as ${failed.dataset.why ?? "nothing"}, not as a missing clip or picture`);
  if (!failed.textContent?.includes("Waiting for a clip or picture from QA.")) wrong.push("the refused line does not say it waits for a clip or picture from QA");
  if (!failed.textContent?.includes("the QA agent records a clip")) {
    byTest("page-highlights-failed-toggle")?.click();
    await settle();
  }
  if (!failed.textContent?.includes("the QA agent records a clip")) wrong.push("the fold does not open on the refusal naming who acts");
  if (byTest("page-highlight-gap")) wrong.push("the open release says No clip");
  const rows = [...document.querySelectorAll<HTMLElement>("[data-testid=page-unnoted-row]")].map((r) => r.textContent ?? "");
  if (!rows.some((r) => r.includes("note needs one sentence"))) wrong.push("the two-sentence note is not named as needing one sentence");
  if (!rows.some((r) => r.includes("note needs a short title"))) wrong.push("the untitled note is not named as needing a short title");
  return [...wrong, ...sideways()];
}

async function readsEnded(t: "light" | "dark"): Promise<string[]> {
  show("ended");
  theme(t);
  await settle();
  const wrong: string[] = [];
  if (!byTest("page-highlight-gap")?.textContent?.includes("No clip")) wrong.push("the shipped release no longer reads the gap its highlight ended with");
  if (byTest("page-highlights-failed")) wrong.push("the shipped release's highlight was refused under a rule written after it");
  if (!document.body.textContent?.includes("A release page opens on what changed for you, then what it proves.")) wrong.push("the shipped release's untitled note is not shown as its whole sentence");
  if (byTest("page-unnoted-row")) wrong.push("the shipped release holds a note back");
  return [...wrong, ...sideways()];
}

window.__witness = {
  cases: [
    { name: "phone-390", width: 390 },
    { name: "desktop-1440", width: 1440 },
  ],
  ready: () => byTest("release-reader") !== null,
  stages: [
    { name: "open-light", run: () => readsOpen("light") },
    { name: "open-dark", run: () => readsOpen("dark") },
    { name: "ended-light", run: () => readsEnded("light") },
    { name: "ended-dark", run: () => readsEnded("dark") },
  ],
};

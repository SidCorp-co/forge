// A draft its master records rather than cuts (ISS-1019), witnessed at 1440 light and 420 dark over
// catalog-fe's draft 0.13.0 as read on dev.519: the project declares no production, so its gate stands
// at NO_RELEASE_GATE. Its one act reads as approving the master's record, Needs attention names the
// blocker in one line before what it removes, the line's detail sits behind it rather than on the face,
// and no raw code is drawn. Each stage counts the page's visible words, the "before" stage with the
// blocker line taken away as the page drew it until now.
//
//   pnpm --filter web-v2 witness witness/release-recorded-draft.witness.tsx --out <dir>

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { ReleaseItemScreen } from "@/features/releases/components/release-item-screen";
import type { ReleaseDetail } from "@/features/releases/types";
import { RULE, gateView, say } from "@/test/said";
import { rawKeysOnFace } from "@/test/screen-face";
import "./entry";
import { firstScreenWords } from "./first-screen";
import { DETAIL, P, USER_PAGE } from "./releases-redesign.fixture";
import { InRouter } from "./router";

const SLUG = "catalog-fe";
const V = "0.13.0";
const NO_GATE = gateView({
  code: "NO_RELEASE_GATE",
  kind: "blocker",
  title: say("standing.gate.title.noGate"),
  sentence: say("standing.gate.noGate"),
  detail: RULE,
  issues: [],
  owner: { kind: "admin", who: say("standing.who.master"), act: say("standing.act.recordLanding") },
});

const detailOf = {
  ...DETAIL,
  key: V,
  version: V,
  name: "Catalog Admin in three lanes",
  production: null,
  promotion: null,
  approvalRequired: false,
  gates: [NO_GATE],
  can: { cut: false, decide: true, split: false },
} as unknown as ReleaseDetail;

const pageOf = (recordedNotCut: boolean) => ({
  ...USER_PAGE,
  header: { ...USER_PAGE.header, version: V, name: "Catalog Admin in three lanes", approval: { required: false, state: "not_asked" as const, by: null, at: null }, recordedNotCut },
  actionRequired: [],
});

window.fetch = async () => new Promise<Response>(() => {});
const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } } });
client.setQueryData(["release", P, V], { release: detailOf });
client.setQueryData(["release-page", P, V, "user"], pageOf(true));
createRoot(document.getElementById("root") as HTMLElement).render(
  <InRouter at={`/projects/${SLUG}/releases/${V}`} pattern="/projects/$slug/releases/$release">
    <QueryClientProvider client={client}>
      <ReleaseItemScreen projectId={P} slug={SLUG} version={V} />
    </QueryClientProvider>
  </InRouter>,
);

const theme = (t: "light" | "dark") => {
  document.documentElement.dataset.theme = t;
  document.documentElement.classList.toggle("dark", t === "dark");
};
const settle = (ms = 200) => new Promise((ok) => setTimeout(ok, ms));
const screenEl = () => document.querySelector<HTMLElement>("[data-testid=release-item-screen]");

function words(stage: string): void {
  const el = screenEl();
  if (!el) return;
  const { count } = firstScreenWords(el, { whole: true });
  console.log(`words ${stage} at ${window.innerWidth} px: ${count}`);
}

function reads(): string[] {
  const wrong: string[] = [];
  const page = screenEl();
  if (!page) return ["no release page is drawn"];
  const approve = document.querySelector("[data-testid=release-approve]");
  if (approve?.textContent !== "Approve record") wrong.push(`the act reads ${approve?.textContent ?? "nothing"}, not Approve record`);
  const items = [...page.querySelectorAll<HTMLElement>("[data-testid=page-attention-item]")];
  const kinds = items.map((i) => i.dataset.kind);
  if (kinds.join() !== "recorded,removed") wrong.push(`Needs attention reads ${kinds.join() || "nothing"}, not the record and what it removes`);
  const line = items.find((i) => i.dataset.kind === "recorded");
  if (line?.textContent !== "Recorded by the master, not cut") wrong.push(`the blocker line reads ${line?.textContent ?? "nothing"}`);
  if (!line?.querySelector("[title]")?.getAttribute("title")) wrong.push("the blocker line has no detail behind it");
  if ((page.textContent ?? "").includes("NO_RELEASE_GATE")) wrong.push("the raw code is drawn on the face");
  const keys = rawKeysOnFace(page);
  if (keys.length > 0) wrong.push(`raw keys on the face: ${keys.join("; ")}`);
  if (document.documentElement.scrollWidth > window.innerWidth) wrong.push(`the page scrolls sideways: ${document.documentElement.scrollWidth} px in ${window.innerWidth}`);
  words("after");
  return wrong;
}

async function before(): Promise<string[]> {
  client.setQueryData(["release-page", P, V, "user"], pageOf(false));
  await settle();
  words("before");
  client.setQueryData(["release-page", P, V, "user"], pageOf(true));
  await settle();
  return [];
}

window.__witness = {
  cases: [
    { name: "phone", width: 420 },
    { name: "desktop", width: 1440 },
  ],
  ready: () => screenEl()?.querySelector("[data-testid=page-attention]") != null,
  stages: [
    { name: "shot", run: async () => (theme(window.innerWidth < 800 ? "dark" : "light"), await settle(), reads()) },
    { name: "before", run: before },
  ],
};

// A release page line says how its outside call was proven (ISS-1329), witnessed at phone and desktop
// width in both themes over a draft release like adminhub-api's 0.28.0: the PGPrints orders line,
// proven only against a mock, reads Simulated in one word with the why on hover; a line proven
// against the provider reads Live; a line no judge said a proof of reads neither. No key on the face,
// and the page never scrolls sideways.
//
//   pnpm --filter web-v2 witness witness/release-line-proof.witness.tsx --out <dir>

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import type { ReleasePage } from "@forge/contracts/release-page";
import { ReleaseItemScreen } from "@/features/releases/components/release-item-screen";
import { rawKeysOnFace } from "@/test/screen-face";
import "./entry";
import { DETAIL, P, SLUG, USER_PAGE } from "./releases-redesign.fixture";
import { InRouter } from "./router";

const [first, second, ...rest] = USER_PAGE.improvements;
const page: ReleasePage = {
  ...USER_PAGE,
  header: { ...USER_PAGE.header, name: "PGPrints orders" },
  improvements: [
    ...(first ? [{ ...first, screen: "Orders · PGPrints", line: "Orders are sent to PGPrints", proof: "simulated" as const }] : []),
    ...(second ? [{ ...second, screen: "Products · PGPrints", line: "PGPrints products sync to the catalog", proof: "live" as const }] : []),
    ...rest,
  ],
  fixes: USER_PAGE.fixes.map((c) => ({ ...c, line: "A cancelled order is cancelled at PGPrints", proof: "simulated" as const })),
};

window.fetch = async () => new Promise<Response>(() => {});
const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } } });
client.setQueryData(["release", P, "0.56.0"], { release: DETAIL });
client.setQueryData(["release-page", P, "0.56.0", "user"], page);
client.setQueryData(["release-page", P, "0.56.0", "developer"], { ...page, view: "developer" });

createRoot(document.getElementById("root") as HTMLElement).render(
  <InRouter at={`/projects/${SLUG}/releases/0.56.0`} pattern="/projects/$slug/releases/$release">
    <QueryClientProvider client={client}>
      <ReleaseItemScreen projectId={P} slug={SLUG} version="0.56.0" />
    </QueryClientProvider>
  </InRouter>,
);

const theme = (t: "light" | "dark") => {
  document.documentElement.dataset.theme = t;
  document.documentElement.classList.toggle("dark", t === "dark");
};
const settle = (ms = 200) => new Promise((ok) => setTimeout(ok, ms));
const tags = () => [...document.querySelectorAll<HTMLElement>("[data-testid=line-proof]")];

function reads(): string[] {
  const wrong: string[] = [];
  const said = tags().map((t) => `${t.dataset.proof}:${(t.textContent ?? "").trim()}`);
  const want = ["simulated:Simulated", "live:Live", "simulated:Simulated"];
  if (said.join() !== want.join()) wrong.push(`the lines read ${said.join() || "no proof"}, not ${want.join()}`);
  for (const t of tags()) {
    const title = t.querySelector("[title]")?.getAttribute("title") ?? "";
    if (!title.includes("outside call")) wrong.push(`the ${t.dataset.proof} tag says no why on hover`);
    const box = t.getBoundingClientRect();
    if (box.right > window.innerWidth + 0.5) wrong.push(`a ${t.dataset.proof} tag runs past the window`);
  }
  const keys = rawKeysOnFace(document.body);
  if (keys.length > 0) wrong.push(`raw keys on the face: ${keys.join("; ")}`);
  if (document.documentElement.scrollWidth > window.innerWidth) {
    wrong.push(`the page scrolls sideways: ${document.documentElement.scrollWidth} px in ${window.innerWidth}`);
  }
  tags()[0]?.scrollIntoView({ block: "center" });
  return wrong;
}

window.__witness = {
  cases: [
    { name: "phone", width: 390, height: 844 },
    { name: "desktop", width: 1440 },
  ],
  ready: () => tags().length > 0,
  stages: [
    { name: "light", run: async () => (theme("light"), await settle(), reads()) },
    { name: "dark", run: async () => (theme("dark"), await settle(), reads()) },
  ],
};

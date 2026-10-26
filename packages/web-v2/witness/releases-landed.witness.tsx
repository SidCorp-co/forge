// The Releases list of a project that declares no production environment and requires a release
// approval, witnessed at phone and desktop width in both themes. Planted from catalog-api on
// 2026-10-26: 0.2.0 landed on `dev` read "Shipped", "Serving production", waiting on nobody, and the
// owner asked "so I don't need to do anything?". It reads landed on `dev`, not in production, and
// waits on the approver to review it and promote it.
//
//   pnpm --filter web-v2 witness witness/releases-landed.witness.tsx --out <dir>

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { ReleasesScreen } from "@/features/releases/components/releases-screen";
import "./entry";
import LIST from "./releases-landed.fixture.json";
import { InRouter } from "./router";

const P = "9208f825-a431-430e-8de1-b4cb3ccc45b1";

window.fetch = async () => new Promise<Response>(() => {});
const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } } });
client.setQueryData(["releases", P], LIST);
createRoot(document.getElementById("root") as HTMLElement).render(
  <InRouter at="/projects/catalog-api/releases" pattern="/projects/$slug/releases">
    <QueryClientProvider client={client}>
      <ReleasesScreen projectId={P} slug="catalog-api" />
    </QueryClientProvider>
  </InRouter>,
);

const theme = (t: "light" | "dark") => {
  document.documentElement.dataset.theme = t;
  document.documentElement.classList.toggle("dark", t === "dark");
};
const settle = () => new Promise((r) => setTimeout(r, 150));
const page = () => document.body.textContent ?? "";

function reads(): string[] {
  const wrong: string[] = [];
  if (page().includes("Serving production")) wrong.push("a release reads as serving production");
  if (!page().includes("Landed on dev, not in production")) wrong.push("0.2.0 does not say it landed on dev, not in production");
  if (!page().includes("review 0.2.0 and promote it to production")) wrong.push("0.2.0 does not wait on its review and promotion");
  if (document.documentElement.scrollWidth > window.innerWidth) wrong.push(`the page scrolls sideways: ${document.documentElement.scrollWidth} px in ${window.innerWidth}`);
  return wrong;
}

window.__witness = {
  cases: [
    { name: "phone", width: 390 },
    { name: "desktop", width: 1440 },
  ],
  ready: () => document.querySelector("[data-testid=releases-screen]") !== null && page().includes("0.2.0"),
  stages: [
    { name: "light", run: async () => (theme("light"), await settle(), reads()) },
    { name: "dark", run: async () => (theme("dark"), await settle(), reads()) },
  ],
};

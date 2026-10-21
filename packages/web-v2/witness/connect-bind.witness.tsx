// Bundle 3: this Forge's GitHub App lands back on Integrations after an install (`?bind=<id>`), and the
// bind drawer opens on what core matched — Forge by the repository it declared, Autoflow by its slug,
// both ticked — while Musetools, which two repositories match, stays unticked with both named.
// One "Bind (2)" confirms. Witnessed at desktop and phone width.
//
//   pnpm --filter web-v2 witness witness/connect-bind.witness.tsx --out <dir>

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { IntegrationsScreen } from "@/features/integrations/components/integrations-screen";
import { ActiveOrgProvider } from "@/features/orgs";
import { sideways, stubCore } from "./connect-flow.fixture";
import "./entry";
import { InRouter } from "./router";

stubCore();

const root = document.getElementById("root");
if (!root) throw new Error("the page has no #root");
createRoot(root).render(
  <InRouter at="/integrations?bind=gh1" pattern="/integrations">
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ActiveOrgProvider>
        <IntegrationsScreen />
      </ActiveOrgProvider>
    </QueryClientProvider>
  </InRouter>,
);

const flow = () => document.querySelector<HTMLElement>("[data-testid=bind-connection-flow]");

function prematched(): string[] {
  const f = flow();
  if (!f) return ["no bind flow is drawn"];
  const wrong = sideways();
  const selects = [...f.querySelectorAll<HTMLSelectElement>("select")].map((s) => s.value);
  // projects are listed by name: Autoflow, Forge, Musetools
  if (JSON.stringify(selects) !== JSON.stringify(["SidCorp-co/autoflow", "SidCorp-co/forge"])) {
    wrong.push(`the drawer opens on ${JSON.stringify(selects)}, not Forge's and Autoflow's matches`);
  }
  if (!f.textContent?.includes("Several repositories match: SidCorp-co/musetools, chuongld/musetools")) {
    wrong.push("Musetools' candidates are not named");
  }
  const submit = [...f.querySelectorAll("button")].find((b) => b.textContent?.startsWith("Bind ("));
  if (submit?.textContent !== "Bind (2)") wrong.push(`the submit reads "${submit?.textContent}"`);
  if (submit?.hasAttribute("disabled")) wrong.push("the submit stays disabled on two matches");
  return wrong;
}

window.__witness = {
  cases: [
    { name: "desktop-1440", width: 1440 },
    { name: "phone-390", width: 390 },
  ],
  ready: () => Boolean(flow()?.querySelector("select")),
  stages: [{ name: "prematched", run: prematched }],
};

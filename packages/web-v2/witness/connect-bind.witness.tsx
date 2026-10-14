// FB-128: a GitHub App made from the Integrations page lands back there after its install step
// (`?bind=<id>`), and each ticked project picks the repository it builds from, bound in one save.
// Witnessed at desktop and phone width.
//
//   pnpm --filter web-v2 witness witness/connect-bind.witness.tsx --out <dir>

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { IntegrationsScreen } from "@/features/integrations/components/integrations-screen";
import { pick, settle, sideways, stubCore } from "./connect-flow.fixture";
import "./entry";
import { InRouter } from "./router";

stubCore();

const root = document.getElementById("root");
if (!root) throw new Error("the page has no #root");
createRoot(root).render(
  <InRouter at="/integrations?bind=c3" pattern="/integrations">
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <IntegrationsScreen />
    </QueryClientProvider>
  </InRouter>,
);

const flow = () => document.querySelector<HTMLElement>("[data-testid=bind-connection-flow]");

async function picked(): Promise<string[]> {
  const f = flow();
  if (!f) return ["no bind flow is drawn"];
  for (const name of ["Forge", "Autoflow"]) {
    [...f.querySelectorAll("label, button")].find((e) => e.textContent?.trim() === name)?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  }
  await settle();
  const selects = [...f.querySelectorAll<HTMLSelectElement>("select")];
  if (selects.length !== 2) return [`${selects.length} repository pickers are drawn for 2 ticked projects`];
  pick(selects[0] as HTMLSelectElement, "SidCorp-co/forge");
  pick(selects[1] as HTMLSelectElement, "SidCorp-co/autoflow");
  await settle();
  const wrong = sideways();
  const submit = [...f.querySelectorAll("button")].find((b) => b.textContent?.startsWith("Bind ("));
  if (submit?.textContent !== "Bind (2)") wrong.push(`the submit reads "${submit?.textContent}"`);
  if (submit?.hasAttribute("disabled")) wrong.push("the submit stays disabled with both repositories picked");
  return wrong;
}

window.__witness = {
  cases: [
    { name: "desktop-1440", width: 1440 },
    { name: "phone-390", width: 390 },
  ],
  ready: () => Boolean(flow()?.querySelector("input, [role=checkbox]")),
  stages: [{ name: "picked", run: picked }],
};

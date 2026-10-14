// FB-128 on the workspace Integrations page, at desktop and phone width: GitHub's return lands here
// naming why it could not finish and the App it left on GitHub, and Add connection opens the flow that
// binds every chosen project in one save — GitHub's create step named after the first project ticked,
// in list order, and a pasted-credential app's own form saying which projects its one save binds.
//
//   pnpm --filter web-v2 witness witness/connect-add.witness.tsx --out <dir>

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
  <InRouter at="/integrations?github=state_expired&app=forge-sidcorp&appOwner=SidCorp-co&appOrg=1" pattern="/integrations">
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <IntegrationsScreen />
    </QueryClientProvider>
  </InRouter>,
);

const banner = () => document.querySelector<HTMLElement>("[data-testid=github-stranded]");
const flow = () => document.querySelector<HTMLElement>("[data-testid=add-connection-flow]");

function stranded(): string[] {
  const b = banner();
  if (!b) return ["no stranded-App banner is drawn"];
  const wrong = sideways();
  if (!b.textContent?.includes("more than an hour old")) wrong.push("the banner does not name why");
  const link = b.querySelector("a")?.getAttribute("href");
  if (link !== "https://github.com/organizations/SidCorp-co/settings/apps/forge-sidcorp") wrong.push(`the banner links ${link}`);
  return wrong;
}

async function githubStep(): Promise<string[]> {
  [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Add connection")?.click();
  await settle();
  const f = flow();
  if (!f) return ["Add connection opened no flow"];
  for (const name of ["Forge", "Autoflow"]) {
    [...f.querySelectorAll("label, button")].find((e) => e.textContent?.trim() === name)?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  }
  const app = f.querySelector<HTMLSelectElement>("select[aria-label=App]");
  if (!app) return ["the flow has no app picker"];
  pick(app, "github");
  await settle(400);
  const wrong: string[] = [];
  if (!f.textContent?.includes("named after Autoflow")) wrong.push("GitHub's step does not say whose name the App takes");
  if (!f.textContent?.includes("Create GitHub App")) wrong.push("GitHub's create step is not drawn");
  return wrong;
}

async function pastedStep(): Promise<string[]> {
  const f = flow();
  const app = f?.querySelector<HTMLSelectElement>("select[aria-label=App]");
  if (!f || !app) return ["the flow is gone"];
  pick(app, "sentry");
  await settle(800);
  return f.textContent?.includes("One save binds Autoflow, Forge") ? [] : ["the form does not say which projects its one save binds"];
}

window.__witness = {
  cases: [
    { name: "desktop-1440", width: 1440 },
    { name: "phone-390", width: 390 },
  ],
  ready: () => Boolean(banner()),
  stages: [
    { name: "stranded", run: stranded },
    { name: "add-github", run: githubStep },
    { name: "add-sentry", run: pastedStep },
  ],
};

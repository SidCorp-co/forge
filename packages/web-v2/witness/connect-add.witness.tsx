// Bundle 3 on the workspace Integrations page, at desktop and phone width: this Forge's GitHub App
// stands in the org's directory naming the installation no project uses and that GitHub keeps it
// private; Add connection's GitHub step is one Connect GitHub button with nothing to tick or fill;
// and while the App awaits completion, Connect GitHub asks for its client secret, never a second App.
//
//   pnpm --filter web-v2 witness witness/connect-add.witness.tsx --out <dir>

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { IntegrationsScreen } from "@/features/integrations/components/integrations-screen";
import { ActiveOrgProvider } from "@/features/orgs";
import { buttonNamed, pick, settle, sideways, stubCore } from "./connect-flow.fixture";
import "./entry";
import { InRouter } from "./router";

stubCore();

const root = document.getElementById("root");
if (!root) throw new Error("the page has no #root");
createRoot(root).render(
  <InRouter at="/integrations" pattern="/integrations">
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ActiveOrgProvider>
        <IntegrationsScreen />
      </ActiveOrgProvider>
    </QueryClientProvider>
  </InRouter>,
);

const detail = () => document.querySelector<HTMLElement>("[data-testid=github-app-row-detail]");
const flow = () => document.querySelector<HTMLElement>("[data-testid=add-connection-flow]");

function directory(): string[] {
  const d = detail();
  if (!d) return ["the GitHub App row draws no detail"];
  const wrong = sideways();
  if (!document.body.textContent?.includes("This Forge")) wrong.push("the App's row is not named this Forge's");
  if (!d.textContent?.includes("Installed on SidCorp-co, not used by any project.")) wrong.push("the unused installation is not named");
  if (!d.textContent?.includes("Private; installs only on SidCorp-co")) wrong.push("the private App is not named");
  return wrong;
}

async function addGithub(): Promise<string[]> {
  buttonNamed(document, "Add connection")?.click();
  await settle();
  const f = flow();
  if (!f) return ["Add connection opened no flow"];
  const app = f.querySelector<HTMLSelectElement>("select[aria-label=App]");
  if (!app) return ["the flow has no app picker"];
  pick(app, "github");
  await settle(600);
  const wrong = sideways();
  if (!buttonNamed(f, "Connect GitHub")) wrong.push("GitHub's step draws no Connect GitHub button");
  if (f.querySelector("[role=checkbox], input[type=checkbox]")) wrong.push("GitHub's step asks for projects to tick");
  if (f.querySelector("input:not([type=checkbox]), textarea")) wrong.push("GitHub's step draws a field to fill");
  return wrong;
}

async function complete(): Promise<string[]> {
  const f = flow();
  const connect = f && buttonNamed(f, "Connect GitHub");
  if (!f || !connect) return ["the Connect GitHub button is gone"];
  connect.click();
  await settle(400);
  const box = f.querySelector<HTMLElement>("[data-testid=github-complete-app]");
  if (!box) return ["an App awaiting completion draws no completion step"];
  const wrong = sideways();
  if (!box.textContent?.includes("Complete this App first")) wrong.push("the step does not say to complete the App first");
  if (!box.querySelector("input[type=password]")) wrong.push("the step has no client secret field");
  // flat: a heading under a hairline, never a card
  const style = getComputedStyle(box);
  if (!box.querySelector("h2, h3, h4")) wrong.push("the step has no heading");
  if (style.borderTopWidth === "0px") wrong.push("the step has no hairline above it");
  for (const side of ["Right", "Bottom", "Left"] as const) {
    if (style[`border${side}Width`] !== "0px") wrong.push(`the step is boxed: border-${side.toLowerCase()} ${style[`border${side}Width`]}`);
  }
  if (style.backgroundColor !== "rgba(0, 0, 0, 0)") wrong.push(`the step is filled: ${style.backgroundColor}`);
  return wrong;
}

window.__witness = {
  cases: [
    { name: "desktop-1440", width: 1440 },
    { name: "phone-390", width: 390 },
  ],
  ready: () => Boolean(detail()),
  stages: [
    { name: "directory", run: directory },
    { name: "add-github", run: addGithub },
    { name: "complete-first", run: complete },
  ],
};

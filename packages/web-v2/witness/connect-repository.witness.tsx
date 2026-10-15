// Bundle 3 on a project's Integrations: a project with no repository binding offers Connect repository
// on its GitHub row, which lists the repositories this Forge's App already sees and links to adding one
// on GitHub; no second App is offered. Witnessed at desktop and phone width.
//
//   pnpm --filter web-v2 witness witness/connect-repository.witness.tsx --out <dir>

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { ProjectIntegrations } from "@/features/integrations";
import { buttonNamed, lineStarts, settle, sideways, stubCore } from "./connect-flow.fixture";
import "./entry";
import { InRouter } from "./router";

stubCore();

const root = document.getElementById("root");
if (!root) throw new Error("the page has no #root");
createRoot(root).render(
  <InRouter at="/projects/autoflow/settings?tab=connections" pattern="/projects/$slug/settings">
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <div className="mx-auto max-w-5xl px-4 py-6">
        <ProjectIntegrations projectId="p2" />
      </div>
    </QueryClientProvider>
  </InRouter>,
);

function row(): string[] {
  const connect = buttonNamed(document, "Connect repository");
  if (!connect) return ["the GitHub row offers no Connect repository"];
  const wrong = sideways();
  const repository = connect.closest("tbody")?.querySelector("tr");
  if (!repository) return [...wrong, "there is no repository row"];
  if (!repository.textContent?.includes("Not connected to GitHub yet")) wrong.push("the repository row does not say it is not connected to GitHub yet");
  if (repository.textContent?.includes("source host")) wrong.push("the repository row speaks of a source host binding");
  // every drawn copy of the path, the folded one at phone width and the column at desktop
  const paths = [...repository.querySelectorAll<HTMLElement>(".font-mono")].filter((el) => el.offsetParent !== null);
  if (paths.length === 0) wrong.push("the repository's path is not drawn");
  for (const path of paths) {
    for (const { before, at } of lineStarts(path)) {
      if (before !== "/") wrong.push(`the path breaks between "${before}" and "${at}", not after a slash`);
    }
  }
  return wrong;
}

async function opened(): Promise<string[]> {
  buttonNamed(document, "Connect repository")?.click();
  await settle(800);
  const dialog = document.querySelector<HTMLElement>("[role=dialog]");
  if (!dialog) return ["Connect repository opened nothing"];
  const wrong = sideways();
  const body = [...dialog.querySelectorAll<HTMLElement>("*")].find((el) => el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflowX !== "visible");
  if (body) wrong.push(`the drawer scrolls sideways: ${body.scrollWidth} px in ${body.clientWidth}`);
  const options = [...dialog.querySelectorAll<HTMLOptionElement>("select option")].map((o) => o.value).filter(Boolean);
  if (!options.includes("SidCorp-co/autoflow")) wrong.push(`the picker lists ${JSON.stringify(options)}`);
  if (!buttonNamed(dialog, "Add a repository on GitHub")) wrong.push("there is no way to add a repository on GitHub");
  if (dialog.textContent?.includes("separate App")) wrong.push("a second App is still offered");
  return wrong;
}

window.__witness = {
  cases: [
    { name: "desktop-1440", width: 1440 },
    { name: "phone-390", width: 390 },
  ],
  ready: () => Boolean(buttonNamed(document, "Connect repository")),
  stages: [
    { name: "row", run: row },
    { name: "connect-repository", run: opened },
  ],
};

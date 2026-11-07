// A project's General settings witnessed at phone and desktop width: no routine-approval switch is
// offered (ISS-1071: the revisions gate and "Plans need approval" left the screen, the stored policy
// kept as it is), and the verify window says a resolved item asks a triager, never that Forge confirms
// a fix itself (the owner's ruling of 2026-10-14).
//
//   pnpm --filter web-v2 witness witness/general-gates.witness.tsx --out <dir>

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { GeneralSettings } from "@/features/project-settings/components/general-section";
import type { ProjectDetail } from "@/features/projects";
import "./entry";
import { InRouter } from "./router";

const P = "11111111-1111-4111-8111-111111111111";
const DETAIL = { id: P, slug: "hop", name: "Hop", orgId: "o1", baseBranch: "dev", members: [], labels: [], archivedAt: null } as unknown as ProjectDetail;
const DOC = { $schema: "https://forge.sidcorp.co/schemas/project-v1.json", version: 1, approvals: { revisions: true }, plan: { approval: { required: true } }, feedback: { verifyWindowDays: 7 } };

window.fetch = async () => new Promise<Response>(() => {});
const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } } });
client.setQueryData(["project", P, "config"], { declared: true, revision: 3, document: DOC });
createRoot(document.getElementById("root") as HTMLElement).render(
  <InRouter at="/projects/hop/settings" pattern="/projects/$slug/settings">
    <QueryClientProvider client={client}>
      <div style={{ padding: 16 }}>
        <GeneralSettings project={DETAIL} canEdit />
      </div>
    </QueryClientProvider>
  </InRouter>,
);

const has = (text: string) => (document.body.textContent ?? "").includes(text);

function reads(): string[] {
  const wrong: string[] = [];
  if (has("A person accepts each requirement revision")) wrong.push("the revisions gate is offered as a switch");
  if (has("Plans need approval")) wrong.push("plan approval is offered as a switch");
  if (!has("Days before a resolved item asks a triager")) wrong.push("the verify window does not say a triager is asked");
  if (has("confirms a fix itself")) wrong.push("a line says Forge confirms a fix itself");
  if (document.documentElement.scrollWidth > window.innerWidth)
    wrong.push(`the page scrolls sideways: ${document.documentElement.scrollWidth} px in a ${window.innerWidth} px window`);
  return wrong;
}

window.__witness = {
  cases: [
    { name: "phone", width: 390 },
    { name: "desktop", width: 1440 },
  ],
  ready: () => has("Days before a resolved item asks a triager"),
  stages: [{ name: "reads", run: reads }],
};

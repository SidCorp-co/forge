// A project's General settings witnessed at phone and desktop width: the revisions gate names the
// re-pin it now holds (REQ-41 BC-10), and the verify window says a resolved item asks a triager, never
// that Forge confirms a fix itself (the owner's ruling of 2026-10-14).
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
const DOC = { $schema: "https://forge.sidcorp.co/schemas/project-v1.json", version: 1, approvals: { revisions: true }, feedback: { verifyWindowDays: 7 } };

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
  if (!has("A person accepts each requirement revision and re-pin")) wrong.push("the revisions gate does not name the re-pin");
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
  ready: () => has("A person accepts each requirement revision"),
  stages: [{ name: "reads", run: reads }],
};

// The one secret door's field (ISS-1348), witnessed at desktop and phone width, light and dark: a room
// agent's link names a production variable not held yet, and the Variables section opens at it with
// its key, environment and kind filled, protected, and its value box focused, ready to type in.
//
//   pnpm --filter web-v2 witness witness/secret-door.witness.tsx --out <dir>

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { VariablesSettings } from "@/features/project-settings/components/variables-section";
import "./entry";
import { InRouter } from "./router";

const P = "11111111-1111-4111-8111-111111111111";
const HELD = {
  id: "22222222-2222-4222-8222-222222222222",
  key: "DATABASE_URL",
  environment: "production",
  type: "secret",
  protected: true,
  fingerprint: "0f0f0f0f0f0f0f0f",
  version: 3,
  value: null,
  updatedAt: "2026-11-18T00:00:00.000Z",
  updatedBy: null,
};

// the link a secret link answered: the field opens from the page's own address
window.history.replaceState(null, "", `${window.location.pathname}?tab=variables&key=GOOGLE_CLIENT_SECRET&environment=production#variables`);
window.fetch = async () => new Promise<Response>(() => {});
const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } } });
client.setQueryData(["project", P, "variables"], {
  variables: [HELD],
  environments: [
    { name: "staging", tier: "staging" },
    { name: "production", tier: "production" },
  ],
  canManage: true,
  proposalsWaiting: 0,
  says: "",
});
client.setQueryData(["project", P, "variables", "proposals"], { proposals: [] });
createRoot(document.getElementById("root") as HTMLElement).render(
  <InRouter at="/projects/epod/settings" pattern="/projects/$slug/settings">
    <QueryClientProvider client={client}>
      <div style={{ padding: 16 }}>
        <VariablesSettings projectId={P} />
      </div>
    </QueryClientProvider>
  </InRouter>,
);

const settle = () => new Promise((r) => setTimeout(r, 200));
const theme = (t: "light" | "dark") => {
  document.documentElement.dataset.theme = t;
  document.documentElement.classList.toggle("dark", t === "dark");
};
const form = () => document.querySelector<HTMLElement>("[data-testid=variable-form]");

function opened(): string[] {
  const wrong: string[] = [];
  const f = form();
  if (!f) return ["no variable form opened at the asked field"];
  const inputs = [...f.querySelectorAll<HTMLInputElement>("input")];
  const selects = [...f.querySelectorAll<HTMLSelectElement>("select")];
  if (!inputs.some((i) => i.value === "GOOGLE_CLIENT_SECRET")) wrong.push("the key is not filled");
  if (selects[0]?.value !== "production") wrong.push(`the environment reads ${selects[0]?.value}, not production`);
  if (selects[1]?.value !== "secret") wrong.push(`the kind reads ${selects[1]?.value}, not secret`);
  const focused = document.activeElement as HTMLInputElement | null;
  if (focused?.type !== "password" || !f.contains(focused)) wrong.push("the value box does not hold the focus");
  if (document.documentElement.scrollWidth > window.innerWidth)
    wrong.push(`the page scrolls sideways: ${document.documentElement.scrollWidth} px in a ${window.innerWidth} px window`);
  return wrong;
}

window.__witness = {
  cases: [
    { name: "desktop", width: 1440 },
    { name: "phone", width: 390, height: 844 },
  ],
  ready: () => form() !== null,
  stages: [
    { name: "light", run: async () => (theme("light"), await settle(), opened()) },
    { name: "dark", run: async () => (theme("dark"), await settle(), opened()) },
  ],
};

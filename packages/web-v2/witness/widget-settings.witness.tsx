// The feedback widget's settings on a project's Integrations, at desktop and phone width in light and
// dark: a signed widget with its embed code, its fields, and its signing secret shown once after a
// rotate, beside how the client backend signs. Nothing may scroll the page sideways; a long snippet
// scrolls inside its own box.
//
//   pnpm --filter web-v2 witness witness/widget-settings.witness.tsx --out <dir>

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { WidgetSettings } from "@/features/integrations/providers/widget/section";
import "./entry";
import { InRouter } from "./router";

const SITE_KEY = "fw_site_Q2xpZW50U2l0ZUtleUZvckRlbW8xMjM0";
const binding = {
  id: "b1",
  provider: "widget",
  label: "",
  role: "service",
  connectionId: "c1",
  config: {
    siteKey: SITE_KEY,
    allowedOrigins: ["https://shop.kettle.example", "https://www.kettle.example"],
    identity: { mode: "signed" },
    title: "Kettle Co. help",
    greeting: "Hi! Tell us what went wrong and we'll pass it on.",
    accent: "#0f766e",
    limits: { turnsPerConversation: 20 },
  },
  active: true,
  bindingActive: true,
  connectionActive: true,
  revision: 3,
  createdAt: "2026-10-16T00:00:00.000Z",
  lastHealthStatus: null,
};

const json = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }));
window.fetch = (input: RequestInfo | URL) => {
  const path = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href).pathname.replace(/^\/api/, "");
  if (path === "/projects/p1/integrations") return json({ items: [binding] });
  if (path.endsWith("/rotate-secret")) return json({ integration: binding, integrationSecret: "fwsig_3f9a1c7e5b2d4a6f8e0c1b3d5f7a9c2e4b6d8f0a", pasteInto: null });
  if (path === "/projects") return json([{ id: "p1", slug: "shop", name: "Shop", orgId: null, archivedAt: null }]);
  if (path === "/orgs") return json([]);
  if (path === "/integration-connections") return json({ items: [] });
  return json({});
};

const root = document.getElementById("root");
if (!root) throw new Error("the page has no #root");
createRoot(root).render(
  <InRouter at="/projects/shop/settings" pattern="/projects/$slug/settings">
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <div className="mx-auto max-w-3xl p-4">
        <WidgetSettings projectId="p1" />
      </div>
    </QueryClientProvider>
  </InRouter>,
);

const width = () => (window.innerWidth >= 1024 ? window.innerWidth : screen.width);
const settle = (ms = 250) => new Promise((ok) => setTimeout(ok, ms));

function look(theme: "light" | "dark") {
  document.documentElement.dataset.theme = theme;
  const wrong: string[] = [];
  if (document.documentElement.scrollWidth > width()) wrong.push(`the page scrolls sideways: ${document.documentElement.scrollWidth} px in ${width()}`);
  const embed = document.querySelector("[data-testid=widget-snippet-embed]");
  if (!embed?.textContent?.includes(SITE_KEY)) wrong.push("the embed code does not carry the site key");
  for (const origin of document.querySelectorAll<HTMLInputElement>("[data-testid=widget-origins] input"))
    if (origin.scrollWidth > origin.clientWidth) wrong.push(`the origin ${origin.value} is cut off: ${origin.scrollWidth} px in ${origin.clientWidth}`);
  return wrong;
}

window.__witness = {
  cases: [
    { name: "desktop-1440", width: 1440 },
    { name: "phone-390", width: 390 },
  ],
  ready: () => Boolean(document.querySelector("[data-testid=widget-signing]")),
  stages: [
    { name: "light", run: () => look("light") },
    {
      name: "secret-dark",
      run: async () => {
        [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === "Rotate secret")?.click();
        await settle();
        const wrong = look("dark");
        if (!document.querySelector("[data-testid=widget-snippet-secret]")) wrong.push("the minted secret is not shown");
        return wrong;
      },
    },
  ],
};

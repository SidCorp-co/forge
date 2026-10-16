// An MCP client's consent page (/oauth/authorize), witnessed at phone and desktop width: the person
// reads who asks and where the answer goes, allowing with nothing picked names each missing pick on
// its own field, and allowing with a reach but no recent sign-in asks for the password in place. The
// page never scrolls sideways, and Allow and Deny stay full-size thumb targets. jsdom lays nothing
// out, so all of it is read here.
//
//   pnpm --filter web-v2 witness witness/mcp-consent.witness.tsx --out <dir>

import type { McpConsentView } from "@forge/contracts/mcp-auth";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { AuthProvider } from "@/providers/auth-provider";
import { Route } from "@/routes/oauth/authorize/index";
import "./entry";
import { InRouter } from "./router";

const VIEW: McpConsentView = {
  client: {
    id: "8a1c2a43-6a54-4b8e-9d55-0b1a6c3f2e10",
    name: "Claude Code",
    redirectHost: "127.0.0.1:43123",
    registeredAt: "2026-10-16T06:00:00Z",
  },
  requestedScopes: ["read", "write"],
  menu: {
    permissions: ["issues:read", "issues:write", "comments:write", "releases:read", "account:read"],
    accountOnly: ["account:read"],
    explicit: ["approvals:approve"],
    full: "*",
  },
};
const PROJECTS = [
  { id: "p1", name: "Forge dev", slug: "forge-dev" },
  { id: "p2", name: "Catalog API for the ePOD storefront deploy", slug: "catalog-api" },
];

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const path = new URL(String(input), "http://forge.test").pathname;
  if (path.endsWith("/auth/me")) return json({ id: "u1", email: "dev@forge.test", hasPassword: true, oauthProviders: [] });
  if (path.endsWith("/mcp-auth/authorize") && init?.method === "POST") {
    return json({ code: "FRESH_AUTH_REQUIRED", message: "fresh authentication required" }, 403);
  }
  if (path.endsWith("/mcp-auth/authorize")) return json(VIEW);
  if (path.endsWith("/projects")) return json(PROJECTS);
  return new Promise<Response>(() => {});
};

const Page = Route.options.component as () => React.ReactNode;
const AT = `/oauth/authorize?${new URLSearchParams({
  client_id: VIEW.client.id,
  redirect_uri: "http://127.0.0.1:43123/callback",
  response_type: "code",
  code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
  code_challenge_method: "S256",
  state: "st-1",
})}`;
const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
createRoot(document.getElementById("root") as HTMLElement).render(
  <InRouter at={AT} pattern="/oauth/authorize">
    <QueryClientProvider client={client}>
      <AuthProvider>
        <Page />
      </AuthProvider>
    </QueryClientProvider>
  </InRouter>,
);

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const buttons = () => [...document.querySelectorAll("button")];
const button = (label: string) => buttons().find((b) => b.textContent?.trim() === label);
const text = () => document.body.textContent ?? "";
/** Phone emulation widens innerWidth to fit content that overflows, so a phone is measured by its screen. */
const width = () => (window.innerWidth >= 1024 ? window.innerWidth : window.screen.width);

function layout(): string[] {
  const wrong: string[] = [];
  const page = document.documentElement.scrollWidth;
  if (page > width()) wrong.push(`the page scrolls sideways: ${page} px in ${width()}`);
  for (const label of ["Allow", "Deny"]) {
    const b = button(label);
    if (!b) {
      wrong.push(`no ${label} button is drawn`);
      continue;
    }
    const r = b.getBoundingClientRect();
    if (r.height < 44) wrong.push(`${label} is ${Math.round(r.height)} px tall, under a 44 px thumb target`);
    if (r.right > width()) wrong.push(`${label} is cut off at ${Math.round(r.right)} px in ${width()}`);
  }
  return wrong;
}

/** Clicks the control a person would: the checkbox or radio drawn beside `label`. */
function pick(label: string) {
  const el = [...document.querySelectorAll("label")].find((l) => l.textContent?.trim() === label);
  const control = el?.querySelector<HTMLElement>("[role=checkbox],[role=radio]") ?? el;
  control?.click();
}

async function blank(): Promise<string[]> {
  const wrong = layout();
  if (!text().includes("Claude Code asks to use Forge as you.")) wrong.push("the page does not say who asks");
  if (!text().includes("127.0.0.1:43123, on this computer")) wrong.push("the page does not say the answer stays on this computer");
  button("Allow")?.click();
  await pause(300);
  for (const said of ["Choose which projects it may reach.", "Choose full access, or the permissions to give."]) {
    if (!text().includes(said)) wrong.push(`allowing with nothing picked does not say "${said}"`);
  }
  return wrong;
}

async function reauth(): Promise<string[]> {
  pick("Only the projects I pick");
  await pause(200);
  pick("Catalog API for the ePOD storefront deploy");
  pick("Only the permissions I pick");
  await pause(200);
  const wrong: string[] = [];
  if (text().includes("account:read")) wrong.push("an account permission is offered to a grant fenced to projects");
  pick("issues:read");
  await pause(100);
  button("Allow")?.click();
  for (let i = 0; i < 40 && !document.querySelector("input[type=password]"); i += 1) await pause(50);
  if (!document.querySelector("input[type=password]")) wrong.push("a refused allow does not ask for the password");
  return [...wrong, ...layout()];
}

window.__witness = {
  cases: [
    { name: "phone", width: 390 },
    { name: "desktop", width: 1440 },
  ],
  ready: () => Boolean(button("Allow")),
  stages: [
    { name: "blank", run: blank },
    { name: "reauth", run: reauth },
  ],
};

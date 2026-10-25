// The sign-in page with every provider configured (REQ-72): each button carries its own provider's
// mark — Google's four-colour G, GitHub's mark — in both themes, and the buttons stay full width at
// phone width. jsdom draws no SVG colour and lays nothing out, so both are read here.
//
//   pnpm --filter web-v2 witness witness/sign-in-marks.witness.tsx --out <dir>

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { AuthProvider } from "@/providers/auth-provider";
import { Route } from "@/routes/_auth/login/index";
import { settle, sideways } from "./connect-flow.fixture";
import "./entry";
import { InRouter } from "./router";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
window.fetch = async (input: RequestInfo | URL) => {
  const path = new URL(String(input), "http://witness.test").pathname.replace(/^\/api/, "");
  if (path === "/auth/oauth/providers") {
    return json({
      providers: [
        { id: "google", label: "Continue with Google" },
        { id: "github", label: "Continue with GitHub" },
      ],
    });
  }
  if (path === "/auth/me") return json({ code: "UNAUTHENTICATED", message: "no session" }, 401);
  return json({});
};

const Page = Route.options.component as () => React.ReactNode;
const root = document.getElementById("root");
if (!root) throw new Error("the page has no #root");
createRoot(root).render(
  <InRouter at="/login">
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <AuthProvider>
        <Page />
      </AuthProvider>
    </QueryClientProvider>
  </InRouter>,
);

const button = (label: string) => [...document.querySelectorAll("a")].find((a) => a.textContent?.trim() === label);

async function marks(): Promise<string[]> {
  await settle();
  const wrong = sideways();
  const google = button("Continue with Google")?.querySelector("svg");
  if (google?.getAttribute("data-mark") !== "google") wrong.push("Google's button carries no Google mark");
  const fills = [...(google?.querySelectorAll("path") ?? [])].map((p) => getComputedStyle(p).fill);
  if (new Set(fills).size !== 4) wrong.push(`Google's mark draws ${new Set(fills).size} colours, not its four: ${fills.join(", ")}`);
  if (button("Continue with GitHub")?.querySelector("svg")?.getAttribute("data-mark") !== "github") {
    wrong.push("GitHub's button carries no GitHub mark");
  }
  return wrong;
}

window.__witness = {
  cases: [
    { name: "desktop-1440", width: 1440 },
    { name: "phone-390", width: 390 },
  ],
  ready: () => Boolean(button("Continue with Google")),
  stages: [
    { name: "light", run: marks },
    { name: "dark", run: () => ((document.documentElement.dataset.theme = "dark"), marks()) },
  ],
};

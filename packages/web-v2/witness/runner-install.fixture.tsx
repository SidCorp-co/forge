// The one command that installs and pairs a runner (REQ-73 BC-5), witnessed where a person meets it:
// the Runners page's "Pair a device" and the pairing page opened with no code. The command names this
// core's own origin, ends in `--setup`, and wraps inside its box at phone width rather than pushing
// the page sideways. jsdom lays nothing out, so it is read here.
//
//   VITE_API_URL=https://forge.example/api pnpm --filter web-v2 witness witness/runner-install-runners.witness.tsx --out <dir>
//   VITE_API_URL=https://forge.example/api pnpm --filter web-v2 witness witness/runner-install-pair.witness.tsx --out <dir>
//
// The page is opened from file://, whose origin is "null", so the core is named at build time.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { ActiveOrgProvider } from "@/features/orgs";
import { PairScreen } from "@/features/pairing/components/pair-screen";
import { RunnersScreen } from "@/features/runners";
import { AuthProvider } from "@/providers/auth-provider";
import { settle, sideways } from "./connect-flow.fixture";
import { InRouter } from "./router";

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
window.fetch = async (input: RequestInfo | URL) => {
  const path = new URL(String(input), "http://witness.test").pathname.replace(/^\/api/, "");
  if (path === "/auth/me") return json({ id: "u1", email: "dev@forge.test", hasPassword: true, oauthProviders: [] });
  if (path === "/orgs") return json([{ id: "o1", name: "SidCorp", role: "owner", isPersonal: false }]);
  if (path === "/devices" || /^\/orgs\/o1\/devices/.test(path)) return json([]);
  return json([]);
};

/** Mounts the Runners page or the pairing page with no code, and declares what the witness reads. */
export function witnessInstallCommand(page: "runners" | "pair"): void {
  const root = document.getElementById("root");
  if (!root) throw new Error("the page has no #root");
  createRoot(root).render(
  <InRouter at={page === "pair" ? "/pair" : "/runners"}>
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <AuthProvider>
        <ActiveOrgProvider>{page === "pair" ? <PairScreen /> : <RunnersScreen />}</ActiveOrgProvider>
      </AuthProvider>
    </QueryClientProvider>
  </InRouter>,
  );
  window.__witness = {
    cases: [
      { name: "desktop-1440", width: 1440 },
      { name: "phone-390", width: 390 },
    ],
    ready: () => Boolean(command()),
    stages: [
      { name: `${page}-light`, run: shown },
      { name: `${page}-dark`, run: () => ((document.documentElement.dataset.theme = "dark"), shown()) },
    ],
  };
}

const command = () => [...document.querySelectorAll("code")].find((c) => c.textContent?.includes("install.sh"));

async function shown(): Promise<string[]> {
  await settle();
  const c = command();
  if (!c) return ["no install command is drawn"];
  const wrong = sideways();
  const origin = (import.meta.env.VITE_API_URL ?? "").replace(/\/api\/?$/, "");
  const want = `curl -fsSL ${origin}/api/install.sh | sh -s -- --setup`;
  if (!/^https?:\/\//.test(origin)) wrong.push("VITE_API_URL names no core, so the command cannot be read against one");
  if (c.textContent !== want) wrong.push(`the command reads "${c.textContent}", not "${want}"`);
  const box = c.parentElement?.getBoundingClientRect();
  const r = c.getBoundingClientRect();
  if (box && r.right > box.right + 1) wrong.push(`the command overflows its box: ${Math.round(r.right)} px past ${Math.round(box.right)}`);
  return wrong;
}

// Bundle 4: the ecosystem page as one sentence, a map of who uses what from whom, what needs attention,
// a flat Connections table and a Technical fold per project. ePOD x Catalog and Autoflow as the dev
// instance read them on 2026-10-15, at desktop and phone width, the overview again in the dark theme.
//
//   pnpm --filter web-v2 witness witness/ecosystem-page.witness.tsx --out <dir>

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import type { Bus } from "@/features/ecosystem/bus";
import { EcosystemScreen } from "@/features/ecosystem/components/ecosystem-screen";
import { settle, sideways, windowWidth } from "./connect-flow.fixture";
import { AUTOFLOW, CATALOG_API_RUN, EPOD_CATALOG, GUIDES } from "./ecosystem-page.fixture";
import "./entry";
import { InRouter } from "./router";

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const BUSES: Record<string, Bus> = { [EPOD_CATALOG.ecosystem.id]: EPOD_CATALOG, [AUTOFLOW.ecosystem.id]: AUTOFLOW };

window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const path = new URL(String(input), "http://witness.test").pathname.replace(/^\/api/, "");
  if ((init?.method ?? "GET") !== "GET") return json({});
  const bus = /^\/ecosystems\/([^/]+)\/bus$/.exec(path);
  if (bus) return json(BUSES[bus[1]]);
  if (path === "/ecosystems/mine") {
    return json({
      ecosystems: [EPOD_CATALOG, AUTOFLOW].map((b) => ({
        id: b.ecosystem.id,
        slug: b.ecosystem.slug,
        name: b.ecosystem.name,
        purpose: null,
        code: b === AUTOFLOW ? "AF" : "EC",
        steward: { id: "o1", name: "SidCorp", mine: false },
        visibility: "all",
        responseDays: {},
        gate: {},
        members: b.projects.map((p) => p.id),
      })),
      invitations: [],
      threads: [],
      drafts: [],
      projects: [...EPOD_CATALOG.projects, ...AUTOFLOW.projects].map((p) => ({ id: p.id, slug: p.slug, name: p.name })),
      mine: [],
    });
  }
  if (path.endsWith(`/builder-runs/${CATALOG_API_RUN.document.id}`)) return json(CATALOG_API_RUN);
  const link = /\/links\/([^/]+)$/.exec(path);
  if (link && GUIDES[link[1]]) return json(GUIDES[link[1]]);
  return json({});
};

const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const root = createRoot(document.getElementById("root") as HTMLElement);
const show = (ecosystemId: string) =>
  root.render(
    <InRouter key={ecosystemId} at={`/ecosystems/${ecosystemId}`} pattern="/ecosystems/$id">
      <QueryClientProvider client={client}>
        <EcosystemScreen ecosystemId={ecosystemId} />
      </QueryClientProvider>
    </InRouter>,
  );
show(EPOD_CATALOG.ecosystem.id);

const all = (selector: string) => [...document.querySelectorAll<HTMLElement>(selector)].filter((el) => el.offsetParent !== null);
const text = (selector: string) => document.querySelector<HTMLElement>(selector)?.innerText ?? "";
const mapDrawn = () => all("[data-testid=map-project]").length > 0;

async function drawn(): Promise<void> {
  for (let i = 0; i < 50 && !(mapDrawn() && text("[data-testid=ecosystem-summary]")); i++) await settle(100);
  await settle(300);
}

/** Every arrow's words sit inside the map, and no project box is drawn outside it. */
function mapHolds(): string[] {
  const wrong: string[] = [];
  const canvas = document.querySelector<HTMLElement>("[data-testid=map-canvas]")?.getBoundingClientRect();
  if (!canvas) return ["the map has no canvas"];
  const scroll = document.querySelector<HTMLElement>("[data-testid=map-scroll]");
  // a phone may scroll a wide map; a desktop window holds the whole of it
  if (windowWidth() >= 1024 && scroll && scroll.scrollWidth > scroll.clientWidth + 1) wrong.push(`the map scrolls sideways at ${window.innerWidth} px: ${scroll.scrollWidth} in ${scroll.clientWidth}`);
  for (const box of all("[data-testid=map-project]")) {
    for (const line of box.querySelectorAll<HTMLElement>("span")) {
      if (line.scrollWidth > line.clientWidth + 1 || line.scrollHeight > box.clientHeight + 1) wrong.push(`"${line.innerText}" is cut short in its box`);
    }
  }
  for (const el of all("[data-testid=map-arrow-label], [data-testid=map-project]")) {
    const r = el.getBoundingClientRect();
    if (r.left < canvas.left - 1 || r.right > canvas.right + 1 || r.top < canvas.top - 1 || r.bottom > canvas.bottom + 1) {
      wrong.push(`"${el.innerText}" is drawn outside the map`);
    }
  }
  return wrong;
}

/** Nothing on the page reaches past the window's right edge, and no box has been scrolled sideways to show it. */
function withinWindow(): string[] {
  const wrong: string[] = [];
  for (const el of document.querySelectorAll<HTMLElement>("#root *")) {
    if (el.scrollLeft > 0) wrong.push(`<${el.tagName.toLowerCase()} class="${el.className}"> is scrolled ${el.scrollLeft} px sideways`);
    if (el.closest("[data-testid=map-scroll], [role=region]") || el.children.length > 0 || el.offsetParent === null) continue;
    const r = el.getBoundingClientRect();
    if (r.right > windowWidth() + 1) wrong.push(`"${el.innerText.slice(0, 60)}" reaches ${Math.round(r.right)} px in a ${windowWidth()} px window`);
  }
  return wrong.slice(0, 6);
}

/** A fold's chevron turns with its own fold only: one nested in an open fold stays pointing right while shut. */
function foldsHonest(): string[] {
  return all("[aria-expanded]").flatMap((trigger) => {
    const chevron = trigger.querySelector("svg");
    if (!chevron) return [];
    const style = getComputedStyle(chevron);
    const turned = style.rotate === "90deg" || style.transform.startsWith("matrix(0");
    const open = trigger.getAttribute("aria-expanded") === "true";
    return turned === open ? [] : [`the "${trigger.innerText.split("\n")[0]}" fold is ${open ? "open" : "shut"} but its chevron is ${turned ? "turned" : "not turned"}`];
  });
}

function overview(): string[] {
  const wrong = [...sideways(), ...mapHolds(), ...withinWindow()];
  const summary = text("[data-testid=ecosystem-summary]");
  const want = "3 projects · catalog-api declares epod's storefront-graphql, not found in code · catalog-fe uses catalog-api's admin-rest-v1 · 2 need attention";
  if (summary !== want) wrong.push(`the summary reads "${summary}"`);
  const boxes = all("[data-testid=map-project]").map((b) => b.innerText.split("\n")[0]);
  if (boxes.length !== 3) wrong.push(`the map draws ${boxes.length} projects: ${boxes.join(", ")}`);
  const arrows = all("[data-testid=map-arrow-label]").map((a) => a.innerText);
  const wantArrows = ["admin-rest-v1 3.2.0 · current", "storefront-graphql 1.2.0 · not found in code"];
  if (JSON.stringify([...arrows].sort()) !== JSON.stringify(wantArrows)) wrong.push(`the map's arrows read ${JSON.stringify(arrows)}`);
  // D1: catalog-fe calls admin-rest-v1 from ten modules, and is one row
  const rows = all("[data-testid=connection-row], [data-testid=connection-item]");
  if (rows.length !== 2) wrong.push(`the Connections table has ${rows.length} rows, not one per consumer and contract`);
  const fe = rows.find((r) => r.innerText.includes("catalog-fe"));
  if (!fe?.innerText.includes("3.2.0 · 10 modules")) wrong.push(`catalog-fe's row reads "${fe?.innerText}"`);
  if (!fe?.innerText.includes("103 operations outside the contract")) wrong.push("catalog-fe's row does not say what it calls outside the contract");
  // D2: the declared use no link backs is said, with what the builder read
  const attention = text("[data-testid=needs-attention]");
  for (const words of [
    "catalog-api declares epod's storefront-graphql 1.2.0, but no call was found",
    "Its builder last read dev at fe1158c on",
    "catalog-fe calls 103 operations outside catalog-api's admin-rest-v1",
    "See what the builder read",
  ]) {
    if (!attention.includes(words)) wrong.push(`Needs attention does not say "${words}"`);
  }
  if (document.body.innerText.includes("No links")) wrong.push('the page still says "No links"');
  const order = ["ecosystem-summary", "ecosystem-map", "needs-attention", "connections", "projects"].map(
    (id) => document.querySelector(`[data-testid=${id}]`)?.getBoundingClientRect().top ?? -1,
  );
  if (order.some((y, i) => y < 0 || (i > 0 && y < order[i - 1]))) wrong.push(`the sections are not in order: ${order.join(", ")}`);
  if (all("[data-testid^=technical-] [data-testid=map-project]").length > 0) wrong.push("a Technical fold is open before anyone opened it");
  return wrong;
}

async function technical(): Promise<string[]> {
  const step = [...document.querySelectorAll<HTMLAnchorElement>("[data-testid=needs-attention] a")].find((a) => a.innerText === "See what the builder read");
  if (!step) return ["there is no link to what the builder read"];
  step.click();
  await settle(600);
  const fold = document.querySelector<HTMLElement>("[data-testid=technical-catalog-api]");
  const wrong = sideways();
  if (!fold?.innerText.includes("write-links")) wrong.push("following the link did not open catalog-api's builder steps");
  if (!fold?.innerText.includes("Nothing matched, so no link to write.")) wrong.push("the skipped step does not say why");
  wrong.push(...foldsHonest(), ...withinWindow());
  const top = document.getElementById("technical-catalog-api")?.getBoundingClientRect().top ?? 9999;
  if (top > window.innerHeight) wrong.push(`the opened fold is ${Math.round(top)} px down, out of view`);
  return wrong;
}

async function guide(): Promise<string[]> {
  const fold = document.querySelector<HTMLElement>("[data-testid=technical-catalog-fe]");
  const open = fold?.querySelector<HTMLButtonElement>("button");
  if (!open) return ["catalog-fe has no Technical fold"];
  open.click();
  await settle(300);
  const module = [...(fold?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find((b) => b.innerText.includes("modules/designs"));
  if (!module) return ["catalog-fe's Technical fold lists no modules/designs"];
  module.click();
  await settle(600);
  module.scrollIntoView({ block: "start" });
  await settle(200);
  const wrong = [...sideways(), ...foldsHonest(), ...withinWindow()];
  const body = fold?.innerText ?? "";
  if (!body.includes("Uses 3 operations outside the contract")) wrong.push("the guide does not count what modules/designs calls outside the contract");
  if (!body.includes("The contract doesn't promise these")) wrong.push("outside the contract is not explained where it occurs");
  return wrong;
}

async function autoflow(): Promise<string[]> {
  show(AUTOFLOW.ecosystem.id);
  await settle(200);
  await drawn();
  window.scrollTo(0, 0);
  const wrong = [...sideways(), ...mapHolds()];
  const summary = text("[data-testid=ecosystem-summary]");
  if (summary !== "2 projects · no project uses another's contract yet") wrong.push(`the summary reads "${summary}"`);
  if (!text("[data-testid=needs-attention]").includes("All clear")) wrong.push("Needs attention does not say all clear in one line");
  if (all("[data-testid=map-project]").length !== 2) wrong.push("the map does not draw both projects");
  if (!text("[data-testid=ecosystem-map]").includes("publishes shop-mcp, shop-mcp-graphql")) wrong.push("autoflow's box does not say what it publishes");
  if (all("[data-testid=map-arrow-label]").length !== 0) wrong.push("the map draws an arrow nobody uses");
  const read = text("[data-testid=technical-autoflow]");
  if (!read.includes("Read 1810f84 · Oct 2")) wrong.push(`autoflow's Technical fold reads "${read}"`);
  return wrong;
}

async function dark(): Promise<string[]> {
  document.documentElement.dataset.theme = "dark";
  show(EPOD_CATALOG.ecosystem.id);
  await settle(200);
  await drawn();
  window.scrollTo(0, 0);
  const wrong = [...sideways(), ...mapHolds()];
  const label = all("[data-testid=map-arrow-label]")[0];
  if (label && getComputedStyle(label).color === getComputedStyle(document.body).backgroundColor) wrong.push("an arrow's words are the page's own background colour");
  return wrong;
}

window.__witness = {
  cases: [
    { name: "desktop-1440", width: 1440 },
    { name: "phone-390", width: 390 },
  ],
  ready: () => mapDrawn() && Boolean(text("[data-testid=ecosystem-summary]")),
  stages: [
    { name: "1-epod-catalog", run: overview },
    { name: "2-builder-read", run: technical },
    { name: "3-module-guide", run: guide },
    { name: "4-autoflow", run: autoflow },
    { name: "5-epod-catalog-dark", run: dark },
  ],
};

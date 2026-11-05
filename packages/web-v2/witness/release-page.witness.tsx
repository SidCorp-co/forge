// A release page in the approved report shape (ISS-1001), witnessed at phone and desktop width in
// both themes over adminhub-fe's draft 0.56.0: its one act at the top, its one proof bar, what users
// see by screen with no key or sha on the face, Needs attention naming the release it ships with and
// what it removes, and everything technical folded. Opened, the Technical section's roster still
// draws seven criteria of one issue as seven lines a reader tells apart (REQ-40 BC-5, ISS-492). Its
// last stage reads a forge-dev version, which wrapped at 420 on dev.515: the page names its release at
// every width, the version on one line.
//
//   pnpm --filter web-v2 witness witness/release-page.witness.tsx --out <dir>

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { ReleaseItemScreen } from "@/features/releases/components/release-item-screen";
import { rawKeysOnFace } from "@/test/screen-face";
import "./entry";
import { DETAIL, DEVELOPER_PAGE, P, SLUG, USER_PAGE } from "./releases-redesign.fixture";
import { InRouter } from "./router";

const BC18 = "A refusal says in plain words what to fix, on that field.";
const SEVEN = [
  "A title left empty is refused on the title field.",
  "A due date in the past is refused on the date field.",
  "An unknown assignee is refused on the assignee field.",
  "A label over 40 characters is refused on the label field.",
  "A duplicate key is refused on the key field.",
  "A priority outside the list is refused on the priority field.",
  "An estimate below zero is refused on the estimate field.",
];

const developer = {
  ...DEVELOPER_PAGE,
  requirements: [
    {
      key: "REQ-34",
      title: "Every refusal names the field and the fix",
      completes: false,
      proven: SEVEN.map((statement, i) => ({ code: "BC-18", statement, short: i === 6, issueKey: "ISS-201", n: i + 2, countedUnderCutover: false })),
      // the page lists the criteria the header counts (ISS-1001): 22 of 22 proven leaves none unproven
      unproven: 0,
      business: { total: 26, proven: [{ code: "BC-18", statement: BC18 }] },
    },
  ],
};

window.fetch = async () => new Promise<Response>(() => {});
const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } } });
client.setQueryData(["release", P, "0.56.0"], { release: DETAIL });
client.setQueryData(["release-page", P, "0.56.0", "user"], USER_PAGE);
client.setQueryData(["release-page", P, "0.56.0", "developer"], developer);
createRoot(document.getElementById("root") as HTMLElement).render(
  <InRouter at={`/projects/${SLUG}/releases/0.56.0`} pattern="/projects/$slug/releases/$release">
    <QueryClientProvider client={client}>
      <ReleaseItemScreen projectId={P} slug={SLUG} version="0.56.0" />
    </QueryClientProvider>
  </InRouter>,
);

const theme = (t: "light" | "dark") => {
  document.documentElement.dataset.theme = t;
  document.documentElement.classList.toggle("dark", t === "dark");
};
const settle = (ms = 150) => new Promise((ok) => setTimeout(ok, ms));
const detail = () => document.querySelector("[data-testid=release-detail]");

function sideways(): string[] {
  return document.documentElement.scrollWidth > window.innerWidth ? [`the page scrolls sideways: ${document.documentElement.scrollWidth} px in ${window.innerWidth}`] : [];
}

function reads(): string[] {
  const wrong: string[] = [];
  const page = detail();
  if (!page) return ["no release page is drawn"];
  if (document.querySelectorAll("[data-testid=release-actions]").length !== 1) wrong.push("the act is not drawn exactly once");
  if (page.querySelector("[data-testid=release-actions]")) wrong.push("the act is repeated under the header");
  const bars = page.querySelectorAll("[data-testid=release-proof]");
  if (bars.length !== 1 || bars[0]?.getAttribute("data-proven") !== "22") wrong.push(`the page draws ${bars.length} proof bars, not one of 22`);
  const keys = rawKeysOnFace(page);
  if (keys.length > 0) wrong.push(`raw keys on the face: ${keys.join("; ")}`);
  const screens = [...page.querySelectorAll("[data-testid=page-screen] dt")].map((d) => d.textContent);
  if (screens[0] !== "Supplier · Mapping") wrong.push(`the first screen reads ${screens[0] ?? "nothing"}`);
  wrong.push(...named("0.56.0"));
  const kinds = [...page.querySelectorAll("[data-testid=page-attention-item]")].map((i) => i.getAttribute("data-kind"));
  if (kinds.join() !== "step,removed") wrong.push(`Needs attention reads ${kinds.join() || "nothing"}, not the release it ships with and what it removes`);
  if (page.querySelector("[data-testid=release-technical-fold]")?.hasAttribute("open")) wrong.push("Technical opens unasked");
  return [...wrong, ...sideways()];
}

/** Technical's still-open list agrees with the header's bar: a release proven whole lists nothing open (ISS-1001). */
function stillOpenAgrees(): string[] {
  const bar = document.querySelector("[data-testid=release-detail] [data-testid=release-proof]");
  const unproven = Number(bar?.getAttribute("data-total")) - Number(bar?.getAttribute("data-proven"));
  const open = document.querySelectorAll("[data-testid=page-known-issue]").length;
  return unproven === 0 && open > 0 ? [`the header proves every criterion and Technical lists ${open} issues still open`] : [];
}

async function technical(): Promise<string[]> {
  const fold = document.querySelector<HTMLDetailsElement>("[data-testid=release-technical-fold]");
  if (!fold) return ["no Technical section is drawn"];
  // shot at 1440 light and at 420 dark, the two the round-2 reading asks for
  theme(window.innerWidth < 800 ? "dark" : "light");
  fold.open = true;
  await settle(300);
  document.querySelector<HTMLButtonElement>("[data-testid=page-change][data-row-key=ISS-201] button")?.click();
  await settle();
  const row = document.querySelector("[data-testid=page-change][data-row-key=ISS-201]");
  row?.scrollIntoView({ block: "start" });
  const lines = [...(row?.querySelectorAll("[data-testid=page-row-detail] li") ?? [])].map((e) => (e.textContent ?? "").trim());
  const wrong: string[] = [];
  if (lines.length !== 7) wrong.push(`ISS-201 opens on ${lines.length} criteria, not 7`);
  if (new Set(lines).size !== lines.length) wrong.push(`ISS-201 draws ${lines.length} lines and only ${new Set(lines).size} read apart`);
  if (!fold.querySelector("[data-testid=release-merges-section]")) wrong.push("Technical lists no change requests");
  return [...wrong, ...stillOpenAgrees(), ...sideways()];
}

/** How many lines a drawn element's text runs over: a flex item is one box, so its text's line boxes are counted. */
function linesOf(el: Element): number {
  const range = document.createRange();
  range.selectNodeContents(el);
  return new Set([...range.getClientRects()].filter((r) => r.width > 0).map((r) => Math.round(r.top))).size;
}

/** The release named at the head of the page as a reader sees it, and every version on it on one line. */
function named(version: string): string[] {
  const shown = [...document.querySelectorAll<HTMLElement>("[data-testid=release-version]")].filter((v) => v.getClientRects().length > 0);
  if (!shown.some((v) => v.textContent === version)) return [`the page does not name ${version} at ${window.innerWidth} px`];
  return shown.flatMap((v) => (linesOf(v) > 1 ? [`${v.textContent} wraps over ${linesOf(v)} lines`] : []));
}

async function devVersion(): Promise<string[]> {
  const version = "0.4.0-dev.515";
  client.setQueryData(["release", P, "0.56.0"], { release: { ...DETAIL, key: version, version, name: "Clearer Release Check Guidance for Approvers" } });
  await settle(300);
  window.scrollTo(0, 0);
  return [...named(version), ...sideways()];
}

window.__witness = {
  cases: [
    { name: "phone", width: 420 },
    { name: "desktop", width: 1440 },
  ],
  ready: () => detail()?.querySelector("[data-testid=page-screens]") != null,
  stages: [
    { name: "light", run: async () => (theme("light"), await settle(), reads()) },
    { name: "dark", run: async () => (theme("dark"), await settle(), reads()) },
    { name: "technical", run: technical },
    { name: "dev-version", run: devVersion },
  ],
};

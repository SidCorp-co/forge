// The Checks section of an issue's Runs tab, witnessed at phone and desktop width (REQ-36 BC-14;
// ISS-474): every check's name is drawn whole, a failed result wears the danger colour, and the
// `text-danger` rule holds on the type styles it sits on and in the dark theme.
//
//   pnpm --filter web-v2 witness witness/check-times.witness.tsx --out <dir>

import { type CheckRunResult, checkTimeByKind, type IssueCheckRunView, type IssueChecksView } from "@forge/contracts/check-runs";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { CheckTimes } from "@/features/issues/components/detail/check-times";
import type { IssueAgentSession } from "@/features/issues/types";
import "./entry";

const SESSION = "5e55a0b1-0000-4000-8000-000000000001";
const sessions: IssueAgentSession[] = [
  {
    id: SESSION,
    status: "completed",
    metadata: null,
    createdAt: "2026-10-09T06:16:38.500Z",
    updatedAt: "2026-10-09T07:02:51.621Z",
    title: "run: ISS-474",
    deviceName: "box-1",
    pipelineRunId: "bb7edd35-30a6-46df-8a1a-914d23676df5",
    heartbeat: "alive",
    continuity: "unknown",
    freshReason: null,
  },
];

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
let n = 0;
function check(kind: IssueCheckRunView["kind"], name: string, scope: string, result: CheckRunResult, durationMs: number, note: string | null = null, run: string | null = SESSION): IssueCheckRunView {
  n += 1;
  return {
    id: `c${n}`,
    kind,
    name,
    scope,
    command: `cmd ${name}`,
    files: [],
    result,
    durationMs,
    startedAt: minutesAgo(n),
    head: "4c1f0e9b".padEnd(40, "0"),
    note,
    runSessionId: run,
    via: "merge-check",
    recordedAt: minutesAgo(n),
  };
}

// The rows the judge's 390 px screenshot cut to "v", "in…" and "dir…", the failed one among them.
const checks = [
  check("conformance", "verify", "workspace", "pass", 210_600),
  check("tests", "integration-tests", "@forge/core integration", "pass", 37_400),
  check("tests", "direct-tests", "scripts", "pass", 1_000),
  check("tests", "direct-tests", "web-v2", "fail", 11_400, "ran with uncommitted changes in packages/web-v2"),
  check("tests", "direct-tests", "@forge/core", "pass", 15_000),
  check("typecheck", "typecheck", "typescript", "pass", 24_700),
  check("base", "rebased-on-base", "dev", "pass", 0),
  check("tests", "direct-tests", "runner/forge-runner-with-a-long-crate-name", "none", 0, null, null),
];
const view: IssueChecksView = { issueId: "witness", totalMs: checks.reduce((s, c) => s + c.durationMs, 0), kinds: checkTimeByKind(checks), checks };

window.fetch = async (input: RequestInfo | URL) =>
  String(input).includes("/issues/witness/checks")
    ? new Response(JSON.stringify(view), { status: 200, headers: { "content-type": "application/json" } })
    : new Response("{}", { status: 404, headers: { "content-type": "application/json" } });

const colourOf = (el: Element | null) => (el ? getComputedStyle(el).color : "missing");
const marked = (name: string) => document.querySelector(`[data-witness="${name}"]`);

/** The colour a token resolves to where `scope` sits, read off a probe element painted with it. */
function tokenColour(token: string, scope: Element = document.body): string {
  const probe = document.createElement("span");
  probe.style.color = `var(${token})`;
  scope.appendChild(probe);
  const colour = getComputedStyle(probe).color;
  probe.remove();
  return colour;
}

const nameOf = (c: IssueCheckRunView) => (c.scope ? `${c.name} (${c.scope})` : c.name);

/** The innermost element of a row whose whole text is the check's name. */
function nameElement(row: Element, name: string): HTMLElement | null {
  const all = [...row.querySelectorAll<HTMLElement>("*")].filter((el) => el.textContent?.trim() === name);
  return all.at(-1) ?? null;
}

function probe(): string[] {
  const wrong: string[] = [];
  const rows = [...document.querySelectorAll("[data-testid=check-run]")];
  checks.forEach((c, i) => {
    const row = rows[i];
    const name = nameOf(c);
    const el = row ? nameElement(row, name) : null;
    if (!el) wrong.push(`check ${i + 1} does not show its name "${name}" whole`);
    else if (el.scrollWidth > el.clientWidth + 1) wrong.push(`check ${i + 1}'s name "${name}" is cut: ${el.clientWidth} of ${el.scrollWidth} px shown`);
    if (row && c.note && !row.textContent?.includes(c.note)) wrong.push(`check ${i + 1} hides its note`);
  });
  if (document.documentElement.scrollWidth > window.innerWidth) wrong.push(`the page scrolls sideways: ${document.documentElement.scrollWidth} px in a ${window.innerWidth} px window`);

  const danger = tokenColour("--fg-danger");
  const muted = tokenColour("--fg-muted");
  if (danger === tokenColour("--fg-default") || danger === muted) wrong.push(`--fg-danger resolves to ${danger}, a colour that is not a danger colour`);
  const failedRow = rows[checks.findIndex((c) => c.result === "fail")];
  const failed = failedRow ? [...failedRow.querySelectorAll("*")].find((el) => el.textContent === "Failed") ?? null : null;
  if (colourOf(failed) !== danger) wrong.push(`a failed check's result is ${colourOf(failed)}, not the danger colour ${danger}`);
  for (const style of ["fg-caption", "fg-body-sm"]) {
    if (colourOf(marked(style)) !== danger) wrong.push(`text-danger on an ${style} line is ${colourOf(marked(style))}, not ${danger}`);
  }
  const dark = marked("dark");
  const darkDanger = dark ? tokenColour("--fg-danger", dark) : "missing";
  if (darkDanger === danger) wrong.push(`the dark theme declares no danger colour of its own (${darkDanger})`);
  if (colourOf(marked("dark-danger")) !== darkDanger) wrong.push(`text-danger in the dark theme is ${colourOf(marked("dark-danger"))}, not ${darkDanger}`);
  return wrong;
}

window.__witness = {
  cases: [
    { name: "check-times-390", width: 390 },
    { name: "check-times-1440", width: 1440 },
  ],
  ready: () => document.querySelectorAll("[data-testid=check-run]").length === checks.length,
  probe,
};

const root = document.getElementById("root");
if (!root) throw new Error("the witness page has no #root to mount into");
const queries = new QueryClient({ defaultOptions: { queries: { retry: false } } });
createRoot(root).render(
  <QueryClientProvider client={queries}>
    <main className="mx-auto max-w-[1100px] space-y-6 p-4">
      <CheckTimes issueId="witness" slug="forge" sessions={sessions} />
      <section className="space-y-1">
        <p className="fg-caption text-danger" data-witness="fg-caption">
          Refused on an fg-caption line
        </p>
        <p className="fg-body-sm text-danger" data-witness="fg-body-sm">
          Refused on an fg-body-sm line
        </p>
        <div data-theme="dark" data-witness="dark">
          <p className="text-danger" data-witness="dark-danger">
            Refused in the dark theme
          </p>
        </div>
      </section>
    </main>
  </QueryClientProvider>,
);

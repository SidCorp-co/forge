// Every surface REQ-48 lane A changed, witnessed as drawn: the Dashboard (Needs you capped at three
// with "+n more" to Approvals, at risk led by what is stuck, the feedback figures counting stuck),
// the status report (Stuck and Needs you before Shipped), /attention (each project's decisions read by
// its total), the requirements list and a requirement page (the stuck banner in core's sentence and
// the steward's note), the feedback list and a feedback page (the FB-74 shape: triaged and stuck),
// the issues table (last write beside the stuck reason) and the board (a card's stuck reason). Each
// stage mounts one surface over the reads it needs and checks what it draws; at 390 px nothing
// scrolls sideways.
//
//   pnpm --filter web-v2 witness witness/steward-surfaces.witness.tsx --out <dir>

import type { ProjectStatus } from "@forge/contracts/project-status";
import type { ItemStanding, StandingSubjectKind, StewardNote } from "@forge/contracts/steward";
import type { QueryKey } from "@tanstack/react-query";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Component, type ReactNode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { AttentionScreen } from "@/features/attention";
import { FeedbackItemScreen, FeedbackScreen } from "@/features/feedback";
import { BaFigures } from "@/features/project-dashboard/components/ba-figures";
import { PipelineBoard } from "@/features/pipeline";
import { ProjectHome } from "@/features/project-home";
import { StatusReport } from "@/features/project-status/components/status-report";
import { RequirementsScreen } from "@/features/requirements/components/requirements-screen";
import { RequirementScreen } from "@/features/requirements/components/requirement-screen";
import { APPROVALS_PROJECT as PH, APPROVALS_READ } from "@/test/approvals-read";
import { STATUS } from "@/test/project-status";
import { RULE, say, verbatim, waitingOn } from "@/test/said";
import { FEEDBACK_SEED, P as FP } from "@/test/vi-chrome-feedback";
import { SCREENS as ISSUE_SCREENS } from "@/test/vi-chrome-issues";
import { REQ_PROJECT, reqQueries, Seeded } from "@/test/vi-chrome-requirements";
import "./entry";
import { InRouter } from "./router";

const AT = "2026-10-14T09:00:00.000Z";
const NOW = "2026-10-21T09:00:00.000Z";
const clock = { lang: "en" as const, now: Date.parse(NOW), timeZone: "UTC" };

// ---- the stuck readings, as core says them ----

const stuckOf = (reason: string, via: string | null) => ({ code: "nobody_serves" as const, since: AT, reason, via, says: { reason: verbatim(reason) } });
const REQ_STUCK = stuckOf("ISS-498 was sent back on 14 Oct and no master serves this project", "ISS-498");
const FB_STUCK = stuckOf("ISS-498 carries it and was sent back on 14 Oct; no master serves this project", "ISS-498");
const ISSUE_STUCK = stuckOf("Sent back on 14 Oct and no master serves this project", null);
const times = (stuck: typeof REQ_STUCK | null) => ({ actClass: "other", since: AT, dueAt: null, stuck, carriedBy: stuck?.via ?? null, basis: "b1" });

const note = (kind: "requirement" | "feedback", key: string): StewardNote => ({
  subject: { kind, key },
  lines: ["ISS-498 was sent back on 14 Oct and no master serves forge-dev.", "Asked the owner to start a master or take ISS-498 by hand."],
  cites: [{ kind: "issue", ref: "ISS-498" }],
  claims: { group: "stuck", stuckCode: "nobody_serves" },
  basis: "b1",
  stale: false,
  writtenAt: AT,
  writtenBy: { id: "steward", name: "Steward", kind: "agent" },
  runId: null,
} as unknown as StewardNote);

const standing = (kind: StandingSubjectKind, key: string, title: string, stuck: typeof REQ_STUCK | null, n: StewardNote | null): ItemStanding =>
  ({
    subject: { kind, key },
    title,
    group: stuck ? "stuck" : "moving",
    waitingOn: waitingOn("agent", { who: say("standing.who.master"), act: say("issues.standing.act.working"), rule: RULE }),
    note: n,
    ...times(stuck),
  }) as unknown as ItemStanding;

const STANDINGS: Record<string, ItemStanding[]> = {
  [REQ_PROJECT]: [standing("requirement", "REQ-1", "Checkout reaches the clinic", REQ_STUCK, note("requirement", "REQ-1"))],
  [FP]: [
    standing("feedback", "FB-3", "Board loses a card on refresh", FB_STUCK, note("feedback", "FB-3")),
    standing("issue", "ISS-1", "Issue one", ISSUE_STUCK, null),
    standing("issue", "ISS-4", "Issue four", ISSUE_STUCK, null),
  ],
};

// ---- the project status the Dashboard and the report read ----

const stuckItem = (kind: "requirement" | "feedback", key: string, title: string, reason: string) => ({
  kind,
  key,
  title,
  code: "nobody_serves" as const,
  reason,
  via: "ISS-498",
  since: AT,
  note: "Asked the owner to start a master or take ISS-498 by hand.",
  href: `/projects/hop/${kind === "requirement" ? "requirements" : "feedback"}/${key}`,
  says: { reason: verbatim(reason) },
});
const WITNESS_STATUS: ProjectStatus = {
  ...STATUS,
  stuck: {
    asOf: NOW,
    count: 2,
    items: [stuckItem("requirement", "REQ-45", "Checkout reaches the clinic", REQ_STUCK.reason), stuckItem("feedback", "FB-74", "Board loses a card on refresh", FB_STUCK.reason)],
  },
  needsYou: {
    asOf: NOW,
    total: APPROVALS_READ.total,
    more: APPROVALS_READ.total - 3,
    decisions: APPROVALS_READ.decisions.slice(0, 3).map((d) => ({
      group: d.group,
      key: d.key,
      title: d.title,
      question: d.proposal ? `${d.proposal.verb}: ${d.proposal.what}` : d.question,
      recommended: d.answers.find((a) => a.recommended)?.label ?? null,
      stuck: d.stuck,
      dueAt: d.dueAt,
      href: `/projects/hop/approvals?peek=${encodeURIComponent(d.id)}`,
    })),
  },
} as ProjectStatus;

// ---- the requirement and feedback reads, stuck ----

const reqSeeds = (): [QueryKey, unknown][] =>
  reqQueries().map(([k, v]): [QueryKey, unknown] => {
    const stuckReq = <T extends { key: string; title: string; standing: Record<string, unknown> }>(r: T): T =>
      r.key === "REQ-1" ? { ...r, title: "Checkout reaches the clinic", standing: { ...r.standing, attentionGroup: "stuck", times: times(REQ_STUCK) } } : r;
    if (k[0] === "requirements") {
      const list = v as { requirements: { key: string; title: string; standing: Record<string, unknown> }[] };
      return [k, { ...list, requirements: list.requirements.map(stuckReq) }];
    }
    if (k[0] === "requirement") return [k, stuckReq(v as { key: string; title: string; standing: Record<string, unknown> })];
    return [k, v];
  });

const fbStuck = <T extends { key: string }>(f: T): T =>
  f.key === "FB-3" || f.key === "FB-2"
    ? {
        ...f,
        title: "Board loses a card on refresh",
        phase: "planned",
        status: "triaged",
        attentionGroup: "stuck",
        route: { route: "issue", carriers: [{ key: "ISS-498", status: "reopen", release: null }], answer: null },
        times: times(FB_STUCK),
      }
    : { ...f, times: times(null) };
const fbSeeds = (): [QueryKey, unknown][] =>
  FEEDBACK_SEED.map(([k, v]): [QueryKey, unknown] => {
    if (k[0] === "feedback" && k.length === 2) {
      const list = v as { feedback: { key: string }[] };
      return [k, { ...list, feedback: list.feedback.map(fbStuck) }];
    }
    if (k[0] === "feedback-item") return [k, { feedback: fbStuck((v as { feedback: { key: string } }).feedback) }];
    return [k, v];
  });

/** The issues the table and the board read: two the standing read reads stuck, one moving. */
const issue = (n: number, title: string, status: string, written: string) => ({
  id: `i${n}`,
  projectId: FP,
  issSeq: n,
  displayId: `ISS-${n}`,
  title,
  status,
  priority: "high",
  category: "bug",
  complexity: "m",
  assigneeId: null,
  createdById: "u1",
  creatorEmail: "lan@example.com",
  creatorIsAgent: false,
  creatorLabel: "Lan",
  reopenCount: status === "reopen" ? 1 : 0,
  mergedAt: null,
  createdAt: AT,
  updatedAt: written,
  lastWriteAt: written,
  moves: [],
  agentStatus: null,
  agentSessions: [],
  workState: null,
});
const ISSUE_ROWS = [
  issue(1, "Wedge reset keeps merged issues", "reopen", AT),
  issue(4, "Align the transition guide", "open", AT),
  issue(7, "Export keeps the old column order", "in_progress", "2026-10-21T08:30:00.000Z"),
];
const listOf = (items: unknown[]) => ({ items, total: items.length, returned: items.length, limit: 200, offset: 0, hasMore: false });

// ---- core, stubbed: every read a surface makes that no seed answers ----

const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
window.fetch = async (input: RequestInfo | URL) => {
  const path = new URL(String(input), "http://forge.test").pathname.replace(/^\/api/, "");
  const standings = /^\/projects\/([^/]+)\/standings$/.exec(path);
  if (standings) return json({ standings: STANDINGS[standings[1] ?? ""] ?? [] });
  const noted = /^\/projects\/[^/]+\/steward-notes\/(requirement|feedback)\/([^/]+)$/.exec(path);
  if (noted) return json({ note: note(noted[1] as "requirement" | "feedback", decodeURIComponent(noted[2] ?? "")) });
  if (path === `/projects/${PH}/needs-you/decisions`) return json(APPROVALS_READ);
  if (path.startsWith(`/projects/${PH}/status`)) return json(WITNESS_STATUS);
  if (path === "/projects") return json([{ id: PH, slug: "hop", name: "Hop", orgId: null, orgRole: null }]);
  if (path === "/me/devices") return json([]);
  if (path === `/projects/${FP}/issues/search`) return json(listOf(ISSUE_ROWS));
  if (path === `/projects/${FP}/pipeline-runs`) return json(listOf([]));
  if (path === "/me/attention") {
    const part = { projectSlug: "hop", projectName: "Hop", total: APPROVALS_READ.total, decisions: APPROVALS_READ.decisions.slice(0, 3) };
    return json({ needsYou: [part], mentions: [], failedJobs: [], channelGates: [], statusReports: [] });
  }
  return new Promise<Response>(() => {});
};
// the fixtures' own pages set the query string with replaceState, which a file:// page refuses for a path
const replace = window.history.replaceState.bind(window.history);
window.history.replaceState = (data, unused, url) => {
  try {
    replace(data, unused, url);
  } catch {
    /* the page stays at its file:// address */
  }
};

const fresh = () => new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } } });
const Live = ({ children }: { children: ReactNode }) => {
  const [client] = useState(fresh);
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
};
const issueScreen = (name: string) => {
  const s = ISSUE_SCREENS.find((x) => x.name === name);
  if (!s) throw new Error(`no issue fixture screen is named "${name}"`);
  return s.render;
};

interface Surface {
  name: string;
  path: string;
  render: () => ReactNode;
  /** What the surface must draw, each a sentence when it does not. */
  check: () => string[];
}

const text = () => document.querySelector("[data-witness=page]")?.textContent ?? "";
const has = (what: string, needle: string): string[] => (text().includes(needle) ? [] : [`${what}: "${needle}" is not drawn`]);

const SURFACES: Surface[] = [
  {
    name: "dashboard",
    path: "/projects/hop",
    render: () => (
      <Live>
        <BaFigures slug="hop" requirements={[{ state: "in_delivery", count: 4 }, { state: "agreed", count: 2 }] as never} feedback={{ open: 12, untriaged: 2, stuck: 1 }} release={null} clock={clock} />
        <ProjectHome projectId={PH} slug="hop" />
      </Live>
    ),
    check: () => [...has("Needs you", `+${APPROVALS_READ.total - 3} more`), ...has("at risk", "REQ-45"), ...has("at risk", "no master serves")],
  },
  {
    name: "status-report",
    path: "/projects/hop/status",
    render: () => (
      <div className="mx-auto max-w-4xl px-4 py-6">
        <StatusReport s={WITNESS_STATUS} slug="hop" clock={clock} />
      </div>
    ),
    check: () => [...has("Stuck", "REQ-45"), ...has("Stuck", "FB-74"), ...has("Needs you", "FB-135")],
  },
  {
    name: "attention",
    path: "/attention",
    render: () => (
      <Live>
        <AttentionScreen />
      </Live>
    ),
    check: () => [...has("attention", "FB-135"), ...has("attention", `+${APPROVALS_READ.total - 3} more`)],
  },
  {
    name: "requirements-list",
    path: "/projects/hop/requirements",
    render: () => (
      <Seeded data={reqSeeds()}>
        <RequirementsScreen projectId={REQ_PROJECT} slug="hop" />
      </Seeded>
    ),
    check: () => has("the list", "ISS-498 was sent back on 14 Oct and no master serves forge-dev."),
  },
  {
    name: "requirement-page",
    path: "/projects/hop/requirements/REQ-1",
    render: () => (
      <Seeded data={reqSeeds()}>
        <RequirementScreen projectId={REQ_PROJECT} slug="hop" reqKey="REQ-1" />
      </Seeded>
    ),
    check: () => [...has("the banner", REQ_STUCK.reason), ...has("the note", "Asked the owner to start a master")],
  },
  {
    name: "feedback-list",
    path: "/projects/hop/feedback",
    render: () => (
      <Seeded data={fbSeeds()}>
        <FeedbackScreen projectId={FP} slug="hop" />
      </Seeded>
    ),
    check: () => has("the list", "Board loses a card on refresh"),
  },
  {
    name: "feedback-page",
    path: "/projects/hop/feedback/FB-2",
    render: () => (
      <Seeded data={fbSeeds()}>
        <FeedbackItemScreen projectId={FP} slug="hop" fbKey="FB-2" />
      </Seeded>
    ),
    check: () => has("the banner", FB_STUCK.reason),
  },
  {
    name: "issues-table",
    path: "/projects/hop/issues",
    render: issueScreen("Issues table"),
    check: () => (document.querySelector(`[data-testid=issue-last-write][data-stuck=true][title="${ISSUE_STUCK.reason}"]`) ? [] : ["no row's last write is marked stuck with core's sentence"]),
  },
  {
    name: "pipeline-board",
    path: "/projects/hop/pipeline",
    render: () => (
      <Live>
        <PipelineBoard scope={{ projectId: FP, slug: "hop" }} />
      </Live>
    ),
    check: () => has("the board", ISSUE_STUCK.reason),
  },
];

const at: { show: (i: number) => void } = { show: () => {} };

/** A surface that throws is named by the stage that drew it. */
class Caught extends Component<{ children: ReactNode }, { error: string | null }> {
  state = { error: null as string | null };
  static getDerivedStateFromError(e: unknown) {
    return { error: e instanceof Error ? `${e.message} ${e.stack?.split("\n").slice(1, 4).join(" ") ?? ""}` : String(e) };
  }
  render() {
    return this.state.error ? <p data-witness="threw">{this.state.error}</p> : this.props.children;
  }
}

function Shell() {
  const [i, setI] = useState(0);
  useEffect(() => {
    at.show = setI;
  });
  const s = SURFACES[i] ?? SURFACES[0];
  if (!s) return null;
  return (
    <InRouter key={s.name} at={s.path} pattern="/$">
      <div className="min-h-dvh bg-app" data-witness="page" data-witness-page={s.name}>
        <Caught key={s.name}>{s.render()}</Caught>
      </div>
    </InRouter>
  );
}

const theme = (t: "light" | "dark") => {
  document.documentElement.dataset.theme = t;
  document.documentElement.classList.toggle("dark", t === "dark");
};
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

window.__witness = {
  cases: [
    { name: "desktop", width: 1440 },
    { name: "phone", width: 390 },
  ],
  ready: () => Boolean(document.querySelector("[data-witness=page]")),
  stages: SURFACES.flatMap((s, i) =>
    (["light", "dark"] as const).map((t) => ({
      name: `${s.name}-${t}`,
      run: async () => {
        theme(t);
        at.show(i);
        await pause(700);
        if (!document.querySelector(`[data-witness-page=${s.name}]`)) return [`the ${s.name} surface is not the one drawn`];
        const threw = document.querySelector<HTMLElement>("[data-witness=threw]");
        if (threw) return [`the ${s.name} surface threw: ${threw.innerText.slice(0, 300)}`];
        const wide = document.documentElement.scrollWidth > window.innerWidth ? [`${s.name} scrolls sideways: ${document.documentElement.scrollWidth} px in ${window.innerWidth}`] : [];
        return [...wide, ...s.check()];
      },
    })),
  ),
};

const root = document.getElementById("root");
if (!root) throw new Error("the witness page has no #root to mount into");
createRoot(root).render(<Shell />);

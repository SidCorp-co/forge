// The reads every REQ-48 lane A surface draws stuck and noted, for the two steward witnesses: the
// stuck readings core says, the steward's note, the one standing read, the project status the
// Dashboard and the report lead with, the requirement and feedback reads made stuck, the issues the
// table and the board read, and core stubbed for every read no seed answers. `mountSurfaces` mounts
// each surface in turn, light then dark, and checks what it draws.

import type { ProjectStatus } from "@forge/contracts/project-status";
import type { ItemStanding, StandingSubjectKind, StewardNote } from "@forge/contracts/steward";
import type { QueryKey } from "@tanstack/react-query";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Component, type ReactNode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { APPROVALS_PROJECT as PH, APPROVALS_READ } from "@/test/approvals-read";
import { STATUS } from "@/test/project-status";
import { RULE, say, verbatim, waitingOn } from "@/test/said";
import { FEEDBACK_SEED, P as FP } from "@/test/vi-chrome-feedback";
import { REQ_PROJECT, reqQueries } from "@/test/vi-chrome-requirements";
import "./entry";
import { InRouter } from "./router";

export { FP, PH, REQ_PROJECT };

const AT = "2026-10-14T09:00:00.000Z";
const NOW = "2026-10-21T09:00:00.000Z";
export const clock = { lang: "en" as const, now: Date.parse(NOW), timeZone: "UTC" };

// ---- the stuck readings, as core says them ----

const stuckOf = (reason: string, via: string | null) => ({ code: "nobody_serves" as const, since: AT, reason, via, says: { reason: verbatim(reason) } });
export const REQ_STUCK = stuckOf("ISS-498 was sent back on 14 Oct and no master serves this project", "ISS-498");
export const FB_STUCK = stuckOf("ISS-498 carries it and was sent back on 14 Oct; no master serves this project", "ISS-498");
export const ISSUE_STUCK = stuckOf("Sent back on 14 Oct and no master serves this project", null);
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

// ---- the steward's day the Dashboard reads: the sweep's share spent, its backlog paced ----

const STEWARD_DAY = {
  day: "2026-10-21T00:00:00.000Z",
  resumesAt: "2026-10-22T00:00:00.000Z",
  handoff: { gatewayTurns: { spent: 6, of: 80 }, runnerJobs: { spent: 1, of: 4 } },
  sweep: { gatewayTurns: { spent: 120, of: 120 }, runnerJobs: { spent: 0, of: 6 } },
  paced: 27,
  quiet: "sweep",
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
export const WITNESS_STATUS: ProjectStatus = {
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

export const reqSeeds = (): [QueryKey, unknown][] =>
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
export const fbSeeds = (): [QueryKey, unknown][] =>
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
  if (path === `/projects/${PH}/steward-budget`) return json(STEWARD_DAY);
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
export const Live = ({ children }: { children: ReactNode }) => {
  const [client] = useState(fresh);
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
};
export interface Surface {
  name: string;
  path: string;
  render: () => ReactNode;
  /** What the surface must draw, each a sentence when it does not. */
  check: () => string[];
  /** What to open before it is checked and shot: a fold, a tab's row. */
  open?: () => void;
}

const text = () => document.querySelector("[data-witness=page]")?.textContent ?? "";
export const has = (what: string, needle: string): string[] => (text().includes(needle) ? [] : [`${what}: "${needle}" is not drawn`]);

export function mountSurfaces(SURFACES: Surface[]) {
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
          if (s.open) {
            s.open();
            await pause(500);
          }
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
}

// The fixtures the screen witnesses share (witness/screens-act, witness/screens-all): the project home's reads answered over a
// stubbed fetch, the ops monitor's seed, and the issue, requirement and feedback seeds given titles of their own words.

import { QueryClient, QueryClientProvider, type QueryKey } from "@tanstack/react-query";
import { Component, type ReactNode, useState } from "react";
import { Route as HomeRoute } from "@/routes/_workspace/projects/$slug/index";
import { APPROVALS_PROJECT as PH, APPROVALS_READ } from "@/test/approvals-read";
import { STATUS } from "@/test/project-status";
import { emptyHome } from "@/test/project-home";
import { FEEDBACK_SEED } from "@/test/vi-chrome-feedback";
import { detailQueries, STANDING_LIST } from "@/test/vi-chrome-issues";
import { AUTOFLOW, EPOD_CATALOG } from "./ecosystem-page.fixture";
import { reqQueries } from "@/test/vi-chrome-requirements";
import { AGREEMENTS_PROJECT, AGREEMENTS_VIEW } from "@/test/agreements.fixture";
import { MINE, REST_READS, THREADS } from "./screens-rest.reads";

export const NOW = "2026-10-21T09:00:00.000Z";
export const day = (i: number) => new Date(Date.parse(NOW) - (29 - i) * 86_400_000).toISOString().slice(0, 10);
export const wave = (i: number, k: number) => Math.max(0, Math.round(3 + 3 * Math.sin((i + k) / 3) + ((i * 7 + k) % 4)));

// ── the project home's reads, answered over a stubbed fetch (as witness/project-dashboard.witness.tsx) ──
const STATE = (s: string) => ({ standing: { state: s } });
export const HOME_READS: [RegExp, () => unknown][] = [
  [/^\/projects$/, () => [{ id: PH, slug: "hop", name: "Hop Clinic API", role: "admin", orgId: null, orgRole: null }]],
  [/\/needs-you\/decisions$/, () => APPROVALS_READ],
  [
    /\/status$/,
    () => ({
      ...STATUS,
      projectId: PH,
      roadmap: {
        ...STATUS.roadmap,
        now: [
          { key: "REQ-4", title: "Referrals", state: "in_delivery", delivery: null, deferral: null },
          { key: "REQ-21", title: "Clinic checkout", state: "in_delivery", delivery: null, deferral: null },
        ],
        next: [{ key: "REQ-10", title: "Staff roles", state: "agreed", delivery: null, deferral: null }],
      },
      requirements: { ...STATUS.requirements, proven: 31, total: 46 },
      inFlight: { ...STATUS.inFlight, byStatus: [{ status: "open", count: 9 }, { status: "in_progress", count: 4 }], open: 20, runningCount: 1 },
    }),
  ],
  [
    /\/metrics\/health$/,
    () => ({
      days: 30,
      series: Array.from({ length: 30 }, (_, i) => ({ day: day(i), throughput: wave(i, 0), stepFailures: wave(i, 5) % 4, retries: wave(i, 2) % 3, interventions: i % 9 === 0 ? 1 : 0 })),
      totals: { throughput: 128, stepFailures: 41, retries: 22, interventions: 4 },
      previous: { throughput: 97, stepFailures: 55, retries: 22, interventions: 7 },
    }),
  ],
  [
    /^\/projects\/[^/]+\/requirements$/,
    () => ({
      requirements: [
        ...Array.from({ length: 3 }, (_, i) => ({ key: `REQ-${i + 1}`, title: `Draft ${i}`, ...STATE("draft") })),
        ...Array.from({ length: 5 }, (_, i) => ({ key: `REQ-${i + 10}`, title: `Agreed ${i}`, ...STATE("agreed") })),
        ...Array.from({ length: 7 }, (_, i) => ({ key: `REQ-${i + 20}`, title: `Delivery ${i}`, ...STATE("in_delivery") })),
      ],
    }),
  ],
  [/^\/projects\/[^/]+\/feedback$/, () => ({ feedback: Array.from({ length: 9 }, (_, i) => ({ key: `FB-${i}`, title: `Feedback ${i}`, phase: i < 4 ? "new" : "in_delivery", attentionGroup: "open", snoozed: false, times: { stuck: null } })) })],
  [/\/forecast\/requirements$/, () => ({ projectId: PH, requirements: [] })],
  [/\/forecast\/feedback$/, () => ({ projectId: PH, items: [] })],
  [
    /\/releases$/,
    () => ({
      releases: [
        { key: "0.4.0", version: "0.4.0", state: "draft", current: false, issueCount: 6, requirements: [], contents: [], criteria: { proven: 0, total: 0 }, verified: { level: "none", proven: 0, total: 0 } },
        { key: "0.3.2", version: "0.3.2", state: "shipped", current: true, issueCount: 4, requirements: [], contents: [], criteria: { proven: 0, total: 0 }, verified: { level: "none", proven: 0, total: 0 } },
      ],
      counts: {},
      approvalRequired: true,
      production: { ok: true, url: "https://api.hop.example" },
      landings: [],
    }),
  ],
  // the Dashboard's open issues and newest shipped releases (ISS-1067): unanswered, the home drew only its loader (ISS-1131)
  [/^\/projects\/[^/]+\/issues\/standing$/, () => STANDING_LIST],
  [
    /\/releases\/shipped$/,
    () => ({
      releases: [{ key: "0.3.2", version: "0.3.2", state: "shipped", current: true, issueCount: 4, requirements: [], contents: [], criteria: { proven: 0, total: 0 }, verified: { level: "none", proven: 0, total: 0 } }],
    }),
  ],
  [/\/workflows$/, () => ({ workflows: [], returned: 0 })],
  [/\/workflow-templates$/, () => ({ templates: [] })],
  [/\/config$/, () => ({ declared: true, revision: 1, document: { project: { description: "The clinic back office: patients, bookings and billing over one API." } } })],
  [/\/steward-budget$/, () => ({ day: NOW, resumesAt: NOW, handoff: { gatewayTurns: { spent: 6, of: 80 }, runnerJobs: { spent: 1, of: 4 } }, sweep: { gatewayTurns: { spent: 2, of: 120 }, runnerJobs: { spent: 0, of: 6 } }, paced: 0, quiet: null })],
  [/^\/memory\/entries$/, () => ({ items: [], counts: { live: 0, superseded: 0, archived: 0 }, returned: 0, total: 0, limit: 100 })],
];

// ── the ecosystems' reads, as witness/ecosystem-page.witness.tsx answers them, and the person's own feedback to Forge ──
const BUSES: Record<string, unknown> = { [EPOD_CATALOG.ecosystem.id]: EPOD_CATALOG, [AUTOFLOW.ecosystem.id]: AUTOFLOW };
export const ECOSYSTEM_ID = EPOD_CATALOG.ecosystem.id;
const ecosystemRow = (b: typeof EPOD_CATALOG) => ({ id: b.ecosystem.id, slug: b.ecosystem.slug, name: b.ecosystem.name, purpose: null, code: b === AUTOFLOW ? "AF" : "EC", steward: { id: "o1", name: "SidCorp", mine: false }, visibility: "all", responseDays: {}, gate: {}, members: b.projects.map((p) => p.id) });
const FEEDBACK_AT = "2026-10-20T08:00:00.000Z";
const told = { answer: null, declined: null, clarification: null, shippedIn: null };
const mineItem = (key: string, title: string, phase: string, from: string, n: number, says: string, running = false) => ({ key, title, kind: "bug", severity: "medium", phase, route: null, origin: { occurrences: n, project: { id: `p-${from}`, slug: from.toLowerCase(), name: from }, issue: null, run: null, clientVersion: "web 0.4.0-dev.260", reporter: { id: "u1", name: "Lan", agency: "human" }, at: FEEDBACK_AT }, createdAt: FEEDBACK_AT, updatedAt: FEEDBACK_AT, progress: { label: "forecast", asOf: FEEDBACK_AT, running, says, work: null, runs: [], waitingOn: [], eta: { estimate: false } }, shipEvidence: null, told });
HOME_READS.push(
  [/^\/ecosystems\/[^/]+\/bus$/, () => EPOD_CATALOG],
  [/^\/ecosystems\/mine$/, () => ({ ecosystems: [EPOD_CATALOG, AUTOFLOW].map(ecosystemRow), invitations: [], threads: THREADS, drafts: [], projects: [...EPOD_CATALOG.projects, ...AUTOFLOW.projects].map((p) => ({ id: p.id, slug: p.slug, name: p.name })), mine: MINE })],
  // the Agreements page's current rules (REQ-90)
  [new RegExp(`^/projects/${AGREEMENTS_PROJECT}/agreements$`), () => AGREEMENTS_VIEW],
  [/^\/forge\/feedback$/, () => ({ feedback: [mineItem("FB-212", "The board drops a card dragged to Done", "new", "HOP", 1, "Waiting to be triaged by Forge's team."), mineItem("FB-198", "forge claim refuses a lease that has expired", "planned", "Autoflow", 4, "ISS-1433 carries it and a run is working on it now.", true), mineItem("FB-160", "The release page cuts the version at phone width", "verified", "Catalog", 2, "Shipped in 0.4.0-dev.244 and verified.")], returned: 3, home: { id: "p-forge", slug: "forge-dev", name: "Forge" }, asOf: FEEDBACK_AT })],
);
// the project home's one read (ISS-1196), at a working project's size: without it the home sits on its loader
const ship = Array.from({ length: 14 }, (_, i) => ({ day: day(i + 16), releases: wave(i, 1), issues: wave(i, 2) * 3 }));
const HOME = {
  ...emptyHome(PH, { decisions: [], total: 0 }),
  product: {
    requirements: 24,
    byState: [{ key: "in_delivery", count: 3 }, { key: "agreed", count: 5 }, { key: "accepted", count: 15 }, { key: "draft", count: 1 }],
    criteria: { proven: 131, total: 182 },
    areas: [{ name: "Clinic", requirements: 14, building: 2, proven: 80, total: 104 }, { name: "Billing", requirements: 10, building: 1, proven: 51, total: 78 }],
    feedbackOpen: 3,
  },
  delivery: { open: 9, byStatus: [{ key: "open", count: 4 }, { key: "in_progress", count: 2 }, { key: "on_hold", count: 2 }, { key: "awaiting_release", count: 1 }], running: 1, issues: [], truncated: false },
  release: { days: ship, shipped: ship.reduce((n, d) => n + d.releases, 0), issues: ship.reduce((n, d) => n + d.issues, 0), byState: [{ key: "shipped", count: 40 }, { key: "failed", count: 1 }, { key: "aborted", count: 2 }], timeline: [], recent: [] },
  audit: { open: 18, cleared: 9, byKind: [{ key: "debt", count: 14 }, { key: "simplify", count: 3 }, { key: "red", count: 1 }], byRating: [{ key: "low", count: 12 }, { key: "medium", count: 6 }], cells: [] },
  feedback: { weeks: Array.from({ length: 6 }, (_, i) => ({ week: day(i * 4 + 6), fixed: wave(i, 3) * 2, declined: wave(i, 5), open: i === 5 ? 3 : 0 })) },
};
HOME_READS.push([/^\/projects\/[^/]+\/home$/, () => HOME]);
// the screens ISS-1137 brought under the budget, ahead of the home's reads: their module rollup is a whole one
HOME_READS.unshift(...REST_READS);
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
window.fetch = async (input: RequestInfo | URL) => {
  const path = new URL(String(input), "http://forge.test").pathname.replace(/^\/api/, "");
  for (const [pattern, answer] of HOME_READS) if (pattern.test(path)) return json(answer());
  if (/\/forecast\/releases\/coming$|\/onboarding$/.test(path)) return json({ error: { code: "NOT_FOUND", message: "none" } }, 404);
  // a read no fixture answers stays in flight, as in the vi walking test
  console.log(`UNANSWERED ${path}`);
  return new Promise<Response>(() => {});
};

/** A fixture list with titles of its own words: the vi fixtures' titles carry their keys ("Muc FB-1"), which would read as a key on the face. */
const titled = (seed: [QueryKey, unknown][], family: string, field: string, names: string[], rows = 0): [QueryKey, unknown][] =>
  seed.map(([key, value]) => {
    if (key[0] !== family || key.length !== 2) return [key, value];
    const list = value as Record<string, { title: string; key?: string }[]>;
    // `rows` repeats the fixture's rows up to that many, each with a key and title of its own: a list screen drawn at a realistic length
    const base = list[field];
    const grown = rows > base.length ? Array.from({ length: rows }, (_, i) => ({ ...base[i % base.length], key: `${family === "requirements" ? "REQ" : "FB"}-${i + 1}` })) : base;
    return [key, { ...list, [field]: grown.map((r, i) => ({ ...r, title: names[i % names.length] })), returned: grown.length }];
  });
export const FEEDBACK_TITLED = titled(FEEDBACK_SEED, "feedback", "feedback", ["Login loops", "Export is empty", "Totals drift", "Slow board", "Wrong date", "Lost draft", "Stale badge", "Bad link"]);
export const REQUIREMENTS_TITLED = titled(reqQueries(), "requirements", "requirements", ["Sign-in", "Invoice export", "Referral intake", "Clinic checkout", "Staff roles", "Booking reminders", "Audit trail", "Patient merge", "Billing codes", "Offline mode", "Data export", "Single sign-on"], 12);

export const ISSUE_TITLED: [QueryKey, unknown][] = detailQueries().map(([key, value]) =>
  key[0] === "issue" && key[1] === "i1" && key.length <= 3 && (value as { displayId?: string }).displayId ? [key, { ...(value as object), title: "Totals drift on export" }] : [key, value],
);

const Home = HomeRoute.options.component as () => ReactNode;
export function HomePage() {
  const [client] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } } }));
  return (
    <QueryClientProvider client={client}>
      <Home />
    </QueryClientProvider>
  );
}

/** A page that throws is named by the stage that drew it, never read as a page with few words. */
export class Caught extends Component<{ children: ReactNode }, { error: string | null }> {
  state = { error: null as string | null };
  static getDerivedStateFromError(e: unknown) {
    return { error: e instanceof Error ? `${e.message} ${e.stack?.split("\n").slice(1, 4).join(" ") ?? ""}` : String(e) };
  }
  render() {
    return this.state.error ? <p data-witness="threw">{this.state.error}</p> : this.props.children;
  }
}
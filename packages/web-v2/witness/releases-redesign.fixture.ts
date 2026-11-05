// adminhub-fe's releases as read on 2026-11-05, the data the approved mockup was drawn from
// (ISS-1001, `forge-local-docs/releases-redesign/`): the draft 0.56.0 waiting on its approver with
// 22 of 22 criteria proven on stg, the 51 landings on stg it carries (0.2.0 to 0.52.0), and what is
// in production. Names and notes are the mockup's, in English; keys and shas are stand-ins.

import type { ReleasePage } from "@forge/contracts/release-page";
import type { ReleaseDetail, ReleaseSummary } from "@/features/releases/types";
import { releasePage, TECHNICAL } from "@/test/release-page";
import { RULE, say, waitingOn } from "@/test/said";

export const P = "6f0c2a4e-7d1b-4f43-9a52-1b9e0c3d5a10";
export const SLUG = "adminhub-fe";
const AT = "2026-11-05T02:40:00.000Z";

const you = (v: string) => waitingOn("you", { who: say("standing.who.you"), act: say("standing.act.approveReleaseV", { v }), rule: RULE });
const nobody = waitingOn("none", { who: say("standing.who.nobody"), act: say("standing.act.none"), rule: RULE });

function summary(version: string, over: Record<string, unknown>): ReleaseSummary {
  const r = {
    key: version,
    version,
    runId: null,
    state: "shipped",
    current: false,
    name: null,
    summary: null,
    issueCount: 3,
    requirements: [],
    criteria: { total: 0, proven: 0, failing: 0, open: 0, unproven: 0 },
    verified: { level: "none", proven: 0, total: 0, check: "recorded", provider: null, judgedOn: null },
    contents: [],
    owner: null,
    ownerAct: null,
    can: { cut: false, decide: false, split: false },
    split: null,
    openedAt: AT,
    releasedAt: AT,
    at: AT,
    cutCount: 1,
    continuedAs: null,
    draftApproval: null,
    attentionGroup: "done",
    waitingOn: nobody,
    ...over,
  };
  return r as unknown as ReleaseSummary;
}

const day = (d: number) => new Date(Date.parse(AT) - d * 86_400_000).toISOString();

const PROVEN = { level: "criteria", proven: 22, total: 22, check: "landed", provider: null, judgedOn: "stg" };

export const DRAFT = summary("0.56.0", {
  state: "draft",
  name: "Catalog sync and EpodSystem order codes",
  issueCount: 11,
  criteria: { total: 22, proven: 22, failing: 0, open: 0, unproven: 0 },
  verified: PROVEN,
  can: { cut: false, decide: true, split: false },
  releasedAt: null,
  at: day(0.015),
  attentionGroup: "needs_you",
  waitingOn: you("0.56.0"),
});

const LANDED = Array.from({ length: 51 }, (_, i) =>
  summary(`0.${52 - i}.0`, { state: "landed", landedOn: "release/stg", at: day(6 + i / 4), releasedAt: day(6 + i / 4), verified: { ...PROVEN, proven: 4, total: 4 } }),
);

const SHIPPED = [
  summary("0.55.0", { name: "Etsy site auth token fixed", releasedAt: day(5), at: day(5) }),
  summary("0.54.0", { name: "Safer site settings", releasedAt: day(7), at: day(7) }),
  summary("0.53.0", { name: "Order list filters", releasedAt: day(9), at: day(9) }),
  summary("0.1.0", { name: "First release", releasedAt: day(40), at: day(40) }),
  summary("0.0.9", { name: "Pilot", releasedAt: day(45), at: day(45) }),
];

export const LIST = {
  releases: [DRAFT, SHIPPED[0], ...LANDED, ...SHIPPED.slice(1)].sort((a, b) => Date.parse(b.at) - Date.parse(a.at)),
  counts: {},
  approvalRequired: true,
  production: { ok: true, name: "production", url: "https://admin.example" },
  landings: [],
};

const ISSUES = [
  ["ISS-201", "Supplier mapping screen has Sync now", 2078],
  ["ISS-202", "EpodSystem orders show reference_id first", 2079],
  ["ISS-203", "API keys page takes the shared frame", 2080],
  ["ISS-204", "Root picks the person when creating an API key", 2080],
  ["ISS-205", "API key list shows names, not ids", 2081],
  ["ISS-206", "Paygate screens stop offering refused actions", 2082],
  ["ISS-207", "Paygate import, bulk update and export for leads only", 2082],
  ["ISS-208", "Proxy VM Switch Provider waits for a provider", 2083],
  ["ISS-209", "Import design drops the Amazon pickers", 2084],
  ["ISS-210", "API contract 13.1.0", 2085],
  ["ISS-211", "Sidebar shows the version", 2086],
] as const;

export const DETAIL = {
  ...DRAFT,
  head: "c54e6b82".padEnd(40, "7"),
  approval: null,
  approvalRequired: true,
  ownerDeploys: false,
  landedOn: null,
  tag: null,
  production: { name: "production", url: "https://admin.example" },
  promotion: {
    label: "!2087",
    number: 2087,
    title: "Promote release/stg to main",
    url: "https://git.example/adminhub-fe/-/merge_requests/2087",
    state: "open",
    from: "release/stg",
    to: "main",
    headSha: "c54e6b82".padEnd(40, "7"),
    mergeCommitSha: null,
    roster: ISSUES.map(([key]) => key),
  },
  issues: ISSUES.map(([key, title, n], i) => ({
    id: `i${i + 1}`,
    key,
    title,
    status: "awaiting_release",
    section: null,
    requirement: null,
    proof: "proven",
    criteria: { total: 2, proven: 2, failing: 0, open: 0, unproven: 0 },
    waitingOn: nobody,
    surfaces: [],
    landing: null,
    unclassified: false,
    changeRequest: { label: `!${n}`, number: n, title, url: `https://git.example/adminhub-fe/-/merge_requests/${n}`, state: "merged", order: null },
  })),
  gates: [],
  cuts: [],
  attempts: [],
  approvals: [],
  issueCriteria: [],
  requirementsCompleted: [],
  feedbackAnswered: [],
  feedbackToldCounts: { told: 0, not_told: 0, before_notices: 0, on_ship: 0 },
  corrections: [],
  notes: { sections: [], designs: [], withoutNotes: [], reworked: [], language: "en", attention: [] },
  changes: TECHNICAL.changes,
  shippedFailing: null,
} as unknown as ReleaseDetail;

const change = (issueKey: string, screen: string, line: string, section: "Added" | "Changed" | "Fixed" | "Removed" = "Changed") => ({
  issueKey,
  kind: section === "Fixed" ? ("fixed" as const) : section === "Added" ? ("new" as const) : ("improved" as const),
  section,
  line,
  detail: null,
  requirementKey: null,
  screen,
});

export const USER_PAGE: ReleasePage = releasePage({
  header: {
    ...releasePage().header,
    version: "0.56.0",
    name: "Catalog sync and EpodSystem order codes",
    state: "draft",
    releasedAt: null,
    verified: PROVEN as ReleasePage["header"]["verified"],
    approval: { required: true, state: "pending", by: null, at: null },
  },
  highlights: { state: "none", why: "no highlight drafted" },
  improvements: [
    change("ISS-201", "Supplier · Mapping", "Sync now pulls the catalog at once, no monthly wait", "Added"),
    change("ISS-202", "EpodSystem orders", "reference_id first, origin_order_id on the line below"),
    change("ISS-203", "API Keys", "Shared page frame"),
    change("ISS-204", "API Keys", "Root picks the person when creating a key", "Added"),
    change("ISS-205", "API Keys", "The list shows names, not IDs"),
    change("ISS-206", "Paygate", "Three refused API buttons are gone"),
    change("ISS-207", "Paygate", "Import, Bulk Update and Export for leads only"),
    change("ISS-209", "Import design", "The two Amazon pickers (Type AMZ, MBA)", "Removed"),
  ],
  fixes: [change("ISS-208", "Proxy VM", "Switch Provider waits for a provider, no more 422", "Fixed")],
  internal: { count: 2, changes: null },
  withoutNotes: [],
  actionRequired: [{ kind: "step", sentence: "Ships with api 0.10.0: picking the person on a new API key needs the new API.", ref: null, issues: ["ISS-204"] }],
  knownIssues: [],
  requirements: [],
});

export const DEVELOPER_PAGE: ReleasePage = { ...USER_PAGE, view: "developer", technical: TECHNICAL };

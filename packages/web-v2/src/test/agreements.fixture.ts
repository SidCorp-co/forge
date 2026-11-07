// A project's working agreements as core answers them (REQ-90), for the Agreements page's tests and
// its screen witness: Forge's nine defaults and two locked guarantees, one override scoped to billing,
// one project-only addition, one conflict with a newer Forge default, and the gate profile and content
// language read from their own configuration. A run's received agreements come from run-context.

import type { AgreementDetailView, AgreementsView, AgreementView } from "@forge/contracts/agreements";
import type { RunContextView } from "@forge/contracts/run-context";
import type { RunStanding } from "@forge/contracts/run-standing";

export const AGREEMENTS_PROJECT = "a9f3c2d1-0000-4000-8000-000000000001";
export const AGREEMENTS_RUN_SESSION = "5e5a1d2c-0000-4000-8000-000000000002";
const AT = "2026-11-07T08:00:00.000Z";
const LATER = "2026-11-07T10:30:00.000Z";
const actor = { id: "u1", name: "Lan" };

const forge = (rule: string, revision = 1, source = "Owner, 2026-11-07") => ({ revision, rule, detail: null, source, restates: [], at: AT });

function inherited(slug: string, name: string, rule: string, locked = false): AgreementView {
  return {
    slug,
    name,
    locked,
    authority: locked ? "kernel" : "agreement",
    door: locked ? null : `PUT /api/projects/${AGREEMENTS_PROJECT}/agreements/${slug}`,
    state: "inherited",
    forge: forge(rule),
    project: null,
    effective: { rule, detail: null, condition: null, from: "forge", revision: "forge@1" },
    conflict: null,
    applies: null,
  };
}

const VERIFY_DEFAULT = "Verify in proportion to a change's impact, widening the checks only on evidence.";
const VERIFY_BILLING = "A billing change runs the billing checks before it lands.";
const AUDIT_OLD = "Audit on a schedule or on real signals.";
const AUDIT_NEW = "Audit weekly and on real signals; refactors happen in the audit.";
const AUDIT_PROJECT = "Audit every Friday, after the week's last release.";
const RELEASE_WINDOW = "Release on weekdays before 16:00, never on a Friday.";

export const AGREEMENT_ROWS: AgreementView[] = [
  inherited("outcome-driven-autonomy", "Outcome-driven autonomy", "An agent chooses how and completes the goal within its granted authority."),
  {
    ...inherited("proportional-verification", "Proportional verification", VERIFY_DEFAULT),
    state: "overridden",
    project: { revision: 2, change: "override", rule: VERIFY_BILLING, detail: null, condition: { labels: ["billing"] }, reason: "Billing broke twice in October", actor, at: LATER, baseRevision: 1 },
    effective: { rule: VERIFY_BILLING, detail: null, condition: { labels: ["billing"] }, from: "project", revision: "project@2" },
  },
  inherited("batch-delivery", "Batch delivery", "Related work goes in batches of at least one whole issue."),
  {
    ...inherited("continuous-audit", "Continuous audit", AUDIT_NEW),
    forge: forge(AUDIT_NEW, 2),
    state: "conflict",
    project: { revision: 1, change: "override", rule: AUDIT_PROJECT, detail: null, condition: null, reason: "Fridays are quiet", actor, at: AT, baseRevision: 1 },
    effective: { rule: AUDIT_PROJECT, detail: null, condition: null, from: "project", revision: "project@1" },
    conflict: { forge: { revision: 2, rule: AUDIT_NEW }, project: { revision: 1, baseRevision: 1, rule: AUDIT_PROJECT }, says: "Forge changed this default after the project's change." },
  },
  inherited("progressive-disclosure", "Progressive disclosure", "Show by default what the current task and decision need."),
  inherited("single-source-of-truth", "Single source of truth", "Each decision has one authoritative source."),
  inherited("evidence-backed-state", "Evidence-backed state", "State reflects its evidence.", true),
  inherited("continuous-improvement", "Continuous improvement", "Audit gates, prompts and skills too."),
  inherited("lean-testing", "Lean testing", "Add a test only where it proves behaviour that matters."),
  inherited("access", "Access", "Who may read, write or act is decided by grants alone.", true),
  {
    ...inherited("gate-profile", "Gate profile", "Gates run under the standard profile, with no per-gate override."),
    authority: "gates",
    door: `PUT /api/projects/${AGREEMENTS_PROJECT}/gates`,
    effective: { rule: "Gates run under the standard profile, with no per-gate override.", detail: null, condition: null, from: "forge", revision: "forge@1" },
  },
  {
    slug: "release-window",
    name: "Release window",
    locked: false,
    authority: "agreement",
    door: `PUT /api/projects/${AGREEMENTS_PROJECT}/agreements/release-window`,
    state: "project_only",
    forge: null,
    project: { revision: 1, change: "addition", rule: RELEASE_WINDOW, detail: null, condition: null, reason: "Support is thin at weekends", actor, at: LATER, baseRevision: null },
    effective: { rule: RELEASE_WINDOW, detail: null, condition: null, from: "project", revision: "project@1" },
    conflict: null,
    applies: null,
  },
];

export const AGREEMENTS_VIEW: AgreementsView = {
  projectId: AGREEMENTS_PROJECT,
  task: null,
  agreements: AGREEMENT_ROWS,
  counts: { inherited: 8, overridden: 1, project_only: 1, conflict: 1, locked: 2 },
};

/** One agreement with its history, newest first. */
export function agreementDetail(slug: string): AgreementDetailView {
  const a = AGREEMENT_ROWS.find((r) => r.slug === slug);
  if (!a) throw new Error(`no agreement ${slug} in the fixture`);
  const history: AgreementDetailView["history"] = [];
  if (a.project) history.push({ layer: "project", revision: a.project.revision, change: a.project.change, rule: a.project.rule, detail: null, condition: a.project.condition, reason: a.project.reason, actor: a.project.actor, at: a.project.at });
  if (slug === "proportional-verification")
    history.push({ layer: "project", revision: 1, change: "override", rule: "A billing change runs every check.", detail: null, condition: null, reason: "First try", actor, at: AT });
  if (a.forge) {
    history.push({ layer: "forge", revision: a.forge.revision, change: "default", rule: a.forge.rule, detail: null, condition: null, reason: null, actor: null, at: a.forge.at });
    if (a.forge.revision > 1) history.push({ layer: "forge", revision: 1, change: "default", rule: AUDIT_OLD, detail: null, condition: null, reason: null, actor: null, at: AT });
  }
  return { ...a, history };
}

/** What one run was given: the billing override at its first revision, since changed, and three defaults. */
export const RUN_CONTEXT: RunContextView = {
  subject: { session: AGREEMENTS_RUN_SESSION },
  reached: [
    { kind: "agreement", ref: "proportional-verification", revision: "project@1", how: "prompt", sessionId: AGREEMENTS_RUN_SESSION, issueId: null, at: AT },
    { kind: "agreement", ref: "outcome-driven-autonomy", revision: "forge@1", how: "prompt", sessionId: AGREEMENTS_RUN_SESSION, issueId: null, at: AT },
    { kind: "agreement", ref: "batch-delivery", revision: "forge@1", how: "prompt", sessionId: AGREEMENTS_RUN_SESSION, issueId: null, at: AT },
    { kind: "agreement", ref: "access", revision: "forge@1", how: "prompt", sessionId: AGREEMENTS_RUN_SESSION, issueId: null, at: AT },
    { kind: "rule", ref: "batch-delivery", revision: "sha256:0123456789abcdef", how: "prompt", sessionId: AGREEMENTS_RUN_SESSION, issueId: null, at: AT },
  ],
  truncated: false,
  unrecorded: { failed: 0, unattributed: 0, since: AT },
};

/** The runs the switch offers: one with a session, one a box never opened. */
export const AGREEMENT_RUNS = {
  items: [
    { id: "r1", sessionId: AGREEMENTS_RUN_SESSION, title: "Build invoice totals", issue: { key: "ISS-12", title: "Invoice totals drift", status: "closed" }, startedAt: AT },
    { id: "r2", sessionId: null, title: "Waiting run", issue: null, startedAt: AT },
  ] as unknown as RunStanding[],
};

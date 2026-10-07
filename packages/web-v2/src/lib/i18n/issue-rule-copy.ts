import { labelCopy } from "./labels";
import { baseOf } from "./product-copy";
import type { Rule, Vars } from "./standing-rule";

// Why an issue waits where it does, as core words a turn's `rule` (`issues/standing.ts`,
// `standing-release.ts`, `strand-rules.ts:landedWait`). A run's own reason after the colon stays as
// the run wrote it; `standing-copy.test.ts` holds each pattern to the sentence core really builds.

const exact = (text: string): RegExp => new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
const raw = (g: Record<string, string>): Vars => ({ ...g });
const KEY = "(?<key>[A-Z][A-Z0-9]*-\\d+)";

export const ISSUE_RULE: Rule[] = [
  { re: new RegExp("^a run parked it on_hold and asked a question only a person can answer: (?<why>.+)$"), key: "issues.rule.parkedAsked", vars: raw },
  { re: new RegExp(`^a run parked it on_hold behind ${KEY}, which still holds it: (?<why>.+)$`), key: "issues.rule.parkedBehind", vars: raw },
  { re: new RegExp("^a run parked it on_hold: (?<why>.+); the master resumes it once that clears$"), key: "issues.rule.parked", vars: raw },
  { re: new RegExp("^the issue is (?<status>closed|dropped)$"), key: "issues.rule.ended", vars: (g, l) => ({ status: baseOf(l) === "en" ? (g.status ?? "") : labelCopy(l)("issueStatus", g.status ?? "") }) },
  { re: exact("a person paused it; a person resumes it"), key: "issues.rule.personPaused" },
  { re: exact("parked at needs_info: a person owes the answer; it wakes the master"), key: "issues.rule.needsInfo" },
  { re: exact("a run asked a question only a person can answer"), key: "issues.rule.runAsked" },
  { re: exact("a draft is not work until a person accepts it"), key: "issues.rule.draft" },
  { re: exact("lease held by a run session that has not ended"), key: "issues.rule.leaseHeldSession" },
  { re: new RegExp("^lease held by (?<holder>.+)$"), key: "issues.rule.leaseHeld", vars: raw },
  { re: exact("a job is queued on it and no run session holds it yet"), key: "issues.rule.queued" },
  { re: new RegExp(`^a live blocks edge from ${KEY}, which delivers a design: (?<design>.+); it settles once that revision is approved$`), key: "issues.rule.blockedDesign", vars: raw },
  { re: new RegExp(`^a live blocks edge from ${KEY}, which has landed and is not settled until a judge passes every criterion$`), key: "issues.rule.blockedLanded", vars: raw },
  { re: new RegExp(`^a live blocks edge from ${KEY}, not yet settled$`), key: "issues.rule.blocked", vars: raw },
  { re: new RegExp("^(?<code>[A-Z_]+): (?<detail>.+) No master is handed it until then\\.$"), key: "issues.rule.withheld", vars: raw },
  { re: exact("in_progress, but no lease is live and no job or run is in flight"), key: "issues.rule.noHolder" },
  { re: exact("sent back with a reason; a master takes it again"), key: "issues.rule.reopen" },
  { re: exact("the plan checkpoint holds; the next run goes straight to build"), key: "issues.rule.approved" },
  {
    re: exact("admitted and nothing withholds it, so the project's master owes it a run; reading whether it is real is the first thing that master's pass does with it, not a gate before it"),
    key: "issues.rule.admitted",
  },
  {
    re: new RegExp("^its approver returned design (?<flow>.+) revision (?<r>\\d+), drawn under this issue: what it owes is the revised design, which a run writes and proposes again, not a judgement of what landed$"),
    key: "issues.rule.designReturned",
    vars: raw,
  },
  {
    re: new RegExp("^the change landed and the issue stands at `(?<status>[a-z_]+)`: the run that claims it next judges what landed and moves it to `awaiting_release` rather than building it$"),
    key: "issues.rule.landed",
    vars: raw,
  },
  {
    re: new RegExp("^(?<n>\\d+) of (?<total>\\d+) criteria have no verdict that passes now, such as one judged on a storefront draft the source has moved past or cannot read back; the release hold keeps it until a run judges them again$"),
    key: "issues.rule.criteriaStale",
    vars: raw,
  },
  {
    re: exact("no release note: a release refuses to carry an issue without one (RELEASE_RECORD_MISSING), and writing it is the master's act, which it is told on its next pass"),
    key: "issues.rule.noNote",
  },
  {
    re: exact("every criterion passed; this project requires a person to approve each release, once per release on Releases (Cut the version, then Approve release), never once per issue"),
    key: "issues.rule.approval",
  },
  { re: exact("a release run holds it"), key: "issues.rule.releaseRunning" },
  { re: exact("every criterion passed; the project releases without an approval"), key: "issues.rule.noApproval" },
];

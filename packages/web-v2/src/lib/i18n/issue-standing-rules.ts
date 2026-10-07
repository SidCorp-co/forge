import { ISSUE_STATUS_LABELS } from "@forge/contracts/issue-vocabulary";
import { labelCopy } from "./labels";
import { productCopy } from "./product-copy";
import type { Rule, Vars } from "./standing-rule";

// An issue's turn and its blocker as core words them in English; `standing-copy.ts` reads them with
// the other standing words, and `standing-copy.test.ts` holds each to a sentence core really writes.

const raw = (g: Record<string, string>): Vars => ({ ...g });

// a run's step word as core writes it (`issues/standing.ts:STEP_WORD`), read through the work-step labels
const STEP = "(?<step>Triage|Clarify|Plan|Build|Test|Release)";
const stepVars = (g: Record<string, string>, language: string): Vars => ({ step: labelCopy(language)("workStep", (g.step ?? "").toLowerCase()), n: g.n ?? "" });

/** Whom an issue waits on (core `issues/standing.ts`, `standing-release.ts`, `strand-rules.ts:landedWait`). */
export const ISSUE_WHO: Rule[] = [
  { re: new RegExp("^Run$"), key: "issues.standing.who.run" },
  { re: new RegExp("^Queued run$"), key: "issues.standing.who.queuedRun" },
  { re: new RegExp("^Next run$"), key: "issues.standing.who.nextRun" },
  { re: new RegExp("^Release$"), key: "issues.standing.who.release" },
  { re: new RegExp("^No holder$"), key: "issues.standing.who.noHolder" },
  { re: new RegExp("^A design approver$"), key: "issues.standing.who.designApprover" },
  { re: new RegExp("^The contract provider$"), key: "issues.standing.who.contractProvider" },
];

/** What an issue waits for (core `issues/standing.ts`, `standing-release.ts`, `answered-wait.ts`, `strand-rules.ts:landedWait`). */
export const ISSUE_ACT: Rule[] = [
  { re: new RegExp("^answer a question$"), key: "issues.standing.act.answer" },
  { re: new RegExp("^make a decision$"), key: "issues.standing.act.decide" },
  { re: new RegExp("^supply what it asks for$"), key: "issues.standing.act.supply" },
  { re: new RegExp("^resume it$"), key: "issues.standing.act.resume" },
  { re: new RegExp("^resume once: (?<why>.+)$"), key: "issues.standing.act.resumeOnce", vars: (g) => ({ why: g.why ?? "" }) },
  { re: new RegExp("^take on or drop$"), key: "issues.standing.act.takeOnOrDrop" },
  { re: new RegExp("^shipped$"), key: "issues.standing.act.shipped" },
  { re: new RegExp("^dropped$"), key: "issues.standing.act.dropped" },
  { re: new RegExp("^working$"), key: "issues.standing.act.working" },
  { re: new RegExp(`^${STEP} · (?<n>\\d+) min$`), key: "issues.standing.act.stepFor", vars: stepVars },
  { re: new RegExp(`^${STEP}$`), key: "issues.standing.act.step", vars: stepVars },
  { re: new RegExp("^design approval$"), key: "issues.standing.act.designApproval" },
  { re: new RegExp("^landed, waits on a judge$"), key: "issues.standing.act.landedWaitsJudge" },
  { re: new RegExp("^landed · claim it and judge what landed$"), key: "issues.standing.act.landedClaim" },
  { re: new RegExp("^running$"), key: "issues.standing.act.running" },
  { re: new RegExp("^needs a person$"), key: "issues.standing.act.needsPerson" },
  { re: new RegExp("^paused$"), key: "issues.standing.act.paused" },
  { re: new RegExp("^came back$"), key: "issues.standing.act.cameBack" },
  { re: new RegExp("^not started$"), key: "issues.standing.act.notStarted" },
  { re: new RegExp("^declare the policy$"), key: "issues.standing.act.declarePolicy" },
  { re: new RegExp("^declare its policy state$"), key: "issues.standing.act.declarePolicyState" },
  { re: new RegExp("^approve the design$"), key: "issues.standing.act.approveDesign" },
  { re: new RegExp("^approve a contract version$"), key: "issues.standing.act.approveContract" },
  { re: new RegExp("^in progress with no live run$"), key: "issues.standing.act.noLiveRun" },
  { re: new RegExp("^re-run after reopen$"), key: "issues.standing.act.rerun" },
  { re: new RegExp("^build next$"), key: "issues.standing.act.buildNext" },
  { re: new RegExp("^dispatch a run$"), key: "issues.standing.act.dispatch" },
  { re: new RegExp("^revise design (?<flow>.+) · revision (?<r>\\d+) returned$"), key: "issues.standing.act.reviseDesign", vars: (g) => ({ flow: g.flow ?? "", r: g.r ?? "" }) },
  { re: new RegExp("^judge it again$"), key: "issues.standing.act.judgeAgain" },
  { re: new RegExp("^Approve release on Releases$"), key: "issues.standing.act.approveOnReleases" },
  { re: new RegExp("^next release$"), key: "issues.standing.act.nextRelease" },
  { re: new RegExp("^wait on (?<key>.+)$"), key: "issues.standing.act.waitOn", vars: (g) => ({ key: g.key ?? "" }) },
  { re: new RegExp("^read the answer$"), key: "issues.standing.act.readAnswer" },
  { re: new RegExp("^read the answer back$"), key: "issues.standing.act.readAnswerBack" },
  { re: new RegExp("^answer the other question$"), key: "issues.standing.act.answerOther" },
  { re: new RegExp("^move it on$"), key: "issues.standing.act.moveOn" },
  { re: new RegExp("^move it on: (?<code>[A-Z_]+)$"), key: "issues.standing.act.moveOnRefused", vars: (g) => ({ code: g.code ?? "" }) },
];

/** A literal sentence as a whole-string pattern. */
const exact = (text: string): RegExp => new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
const RESUME_IT = " Resume it from the status menu once it can go on.";
const issueStatusOf = (label: string): string | null =>
  Object.entries(ISSUE_STATUS_LABELS).find(([, l]) => l === label)?.[0] ?? null;

// Why an issue is not moving and who moves it (core `issues/standing-blocker.ts`, `answered-wait.ts`),
// a queued step's gate (`pipeline-health-reasons.ts:GATE_READINGS`) and a paused run's reading
// (`pauseReading`): the reason, the next step and the button the blocker banner draws.
export const BLOCKER: Rule[] = [
  ...(
    [
      ["This issue is waiting for information — an answer to a question.", "issues.blocker.owesInformation"],
      ["Anyone on the project can answer it; the question is below.", "issues.blocker.whoInformation"],
      ["This issue is waiting for a decision — a judgement only a person can make.", "issues.blocker.owesDecision"],
      ["Whoever owns the call decides, then resumes it where it stopped.", "issues.blocker.whoDecision"],
      ["This issue is waiting for something only a person can supply — an account, a credential, or data.", "issues.blocker.owesResource"],
      ["Supply it, then resume it where it stopped.", "issues.blocker.whoResource"],
      ["The question this issue asked has an answer on the thread.", "issues.blocker.answered"],
      ["Resume it where it stopped once the answer is enough to go on.", "issues.blocker.whoAnswered"],
      ["Nothing says where this issue picks up again — Move anyway… in the status menu lists every move.", "issues.blocker.noResumeAt"],
      ["Nothing says where this issue picks up again — the status menu lists every status it may return to.", "issues.blocker.noResumeFromHold"],
      ["Answer it", "issues.blocker.actAnswer"],
      ["Open blocking issue", "issues.blocker.actOpenBlocker"],
      ["Resume run", "issues.blocker.actResumeRun"],
      ["Finish the blocking issue(s) first.", "issues.blocker.finishBlockers"],
      ["This issue is stopped until a person acts.", "issues.blocker.stopped"],
      ["What it waits on could not be read — read the thread.", "issues.blocker.unreadable"],
      ["The issue is paused.", "issues.blocker.paused"],
      ["An operator can resume it when the work is wanted again.", "issues.blocker.whoPaused"],
      ["That run moves the issue on once it reads the answer.", "issues.blocker.whoRunReads"],
      ["Its question was answered, and a box registered to read that answer back.", "issues.blocker.boxReads"],
      ["The run on that box moves the issue on once it reads the answer.", "issues.blocker.whoBoxReads"],
      ["It moves on once that question is answered.", "issues.blocker.whoOtherQuestion"],
      ["Its question was answered, and nothing recorded the status this park left, so the answer could not return it.", "issues.blocker.noLeftStatus"],
      [`A person names where it goes.${RESUME_IT}`, "issues.blocker.whoNamesWhere"],
      ["Its question was answered; this project is not autonomous, so an answer moves nothing.", "issues.blocker.staged"],
      [`A person resumes it where it stopped.${RESUME_IT}`, "issues.blocker.whoResumes"],
      [`A person resumes it once that wait is over.${RESUME_IT}`, "issues.blocker.whoWaitOver"],
      ["Its question was answered, and nothing recorded what the answer did to it.", "issues.blocker.unrecorded"],
      ...(["issue_busy", "run_not_running", "runner_stale", "retry_cooldown", "runner_too_old", "job_held_clears", "job_held_stays"] as const).flatMap(
        (g) => [`issues.gate.${g}.detail`, `issues.gate.${g}.who`] as const,
      ).map((key) => [productCopy("en")(key), key] as const),
      ...(["operator", "machine", "sweeper"] as const).map((r) => [productCopy("en")(`issues.pause.${r}.who`), `issues.pause.${r}.who`] as const),
    ] as const
  ).map(([text, key]): Rule => ({ re: exact(text), key })),
  {
    re: new RegExp("^Resume at (?<status>.+)$"),
    key: "issues.blocker.actResumeAt",
    vars: (g, l) => {
      const at = issueStatusOf(g.status ?? "");
      return at === null ? null : { status: labelCopy(l)("issueStatus", at) };
    },
  },
  { re: new RegExp("^Blocked by (?<keys>.+), which delivers a design not yet approved: (?<holds>.+)\\.$"), key: "issues.blocker.designOne", vars: raw },
  { re: new RegExp("^Blocked by (?<keys>.+), which deliver designs not yet approved: (?<holds>.+)\\.$"), key: "issues.blocker.designMany", vars: raw },
  { re: new RegExp("^The design approver decides the revision (?<keys>.+) delivers; this issue is released once it is approved\\.$"), key: "issues.blocker.whoDesignOne", vars: raw },
  { re: new RegExp("^The design approver decides the revision (?<keys>.+) deliver; this issue is released once it is approved\\.$"), key: "issues.blocker.whoDesignMany", vars: raw },
  { re: new RegExp("^Blocked by (?<keys>.+), which has landed and waits on a judge\\.$"), key: "issues.blocker.landedOne", vars: raw },
  { re: new RegExp("^Blocked by (?<keys>.+), which have landed and wait on a judge\\.$"), key: "issues.blocker.landedMany", vars: raw },
  { re: new RegExp("^A judge records a verdict on each criterion of (?<keys>.+); this issue is released once it passes\\.$"), key: "issues.blocker.whoLandedOne", vars: raw },
  { re: new RegExp("^A judge records a verdict on each criterion of (?<keys>.+); this issue is released once they pass\\.$"), key: "issues.blocker.whoLandedMany", vars: raw },
  { re: new RegExp("^Blocked by 1 open issue\\.$"), key: "issues.blocker.openOne" },
  { re: new RegExp("^Blocked by (?<n>\\d+) open issues\\.$"), key: "issues.blocker.openMany", vars: raw },
  { re: new RegExp("^Its question was answered, and the answer says it still waits on (?<key>[A-Z]+-\\d+): (?<why>.+)$"), key: "issues.blocker.waitsOnKey", vars: raw },
  { re: new RegExp("^(?<key>[A-Z]+-\\d+) settles first; its blocks edge holds this issue until then\\.$"), key: "issues.blocker.whoSettles", vars: raw },
  { re: new RegExp("^Its question was answered, and the answer says it still waits: (?<why>.+)$"), key: "issues.blocker.stillWaits", vars: raw },
  { re: new RegExp("^Its question was answered, and the answer went to the run that asked \\(session (?<id>[^)]+)\\)\\.$"), key: "issues.blocker.sentToRun", vars: raw },
  { re: new RegExp("^Its question was answered, and another question on it is still open \\((?<ids>[^)]*)\\)\\.$"), key: "issues.blocker.otherQuestion", vars: raw },
  { re: new RegExp("^Its question was answered, and returning it to work was refused: (?<code>[A-Z_]+) — (?<detail>.+)$"), key: "issues.blocker.refused", vars: raw },
  { re: new RegExp(`^Clear what the refusal names, then move it on\\.${RESUME_IT.replace(/\./g, "\\.")}$`), key: "issues.blocker.whoRefused" },
  {
    re: new RegExp("^(?<base>.+?) It is held by (?<kind>.+?)(?: at (?<at>.+))?\\.$"),
    key: "issues.pause.heldBy",
    vars: (g, l) => {
      const base = pauseBase(g.base ?? "", l);
      return base === null ? null : { base, kind: g.kind ?? "", at: g.at ? productCopy(l)("issues.pause.at", { at: g.at }) : "" };
    },
  },
  {
    re: new RegExp("^(?<base>.+?) An operator paused it\\.$"),
    key: "issues.pause.byOperator",
    vars: (g, l) => {
      const base = pauseBase(g.base ?? "", l);
      return base === null ? null : { base };
    },
  },
];

/** A paused run's own detail (core `pauseReading`'s PAUSE_READINGS), the sentence before what holds it. */
function pauseBase(text: string, language: string): string | null {
  const en = productCopy("en");
  for (const r of ["operator", "machine", "sweeper"] as const) {
    if (en(`issues.pause.${r}.detail`) === text) return productCopy(language)(`issues.pause.${r}.detail`);
  }
  return null;
}


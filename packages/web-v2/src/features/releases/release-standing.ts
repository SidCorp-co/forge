import type { ReleaseState } from "@forge/contracts/releases";
import type { Copy } from "@/lib/i18n/product-copy";
import type { ReleaseDetail } from "./types";

// Where a release stands, in the plain words a product owner reads (REQ-40 BC-19): its status, who
// approves it, where it goes, what was checked, and the one next step. Read off the release record,
// so the page's rail and the list's peek say the same thing in the same words. A release whose owner
// deploys ends at its last merge (REQ-71 BC-6): it goes nowhere Forge deploys, and nothing is missing.

export interface ReleaseStanding {
  status: string;
  approver: string;
  goesTo: string;
  verified: string;
  /** The one act that moves it on; null once it is out. */
  next: string | null;
}

type Standing = Pick<ReleaseDetail, "state" | "releasedAt" | "approval" | "approvalRequired" | "production" | "ownerDeploys" | "verified" | "landedOn">;

function statusOf(r: Standing, t: Copy, date: (iso: string) => string): string {
  if (r.state === "shipped" && r.ownerDeploys) {
    return r.releasedAt ? t("releases.standing.status.mergedAt", { at: date(r.releasedAt) }) : t("releases.standing.status.merged");
  }
  if (r.state === "in_progress" && r.ownerDeploys) return t("releases.standing.status.merging");
  if (r.state === "shipped" && r.releasedAt) return t("releases.standing.status.shippedAt", { at: date(r.releasedAt) });
  // a landing on a branch production does not deploy from: production does not serve it
  if (r.state === "landed" && r.landedOn) return t("releases.standing.status.landedOn", { branch: r.landedOn });
  return t(`releases.standing.status.${r.state}`);
}

function approverOf(r: Standing, t: Copy): string {
  const decided = r.approval?.decision ? r.approval.decidedBy : null;
  if (decided) return decided.name;
  return r.approvalRequired || r.approval ? t("releases.standing.approver.admin") : t("releases.standing.approver.notNeeded");
}

// on a project naming its testing environment, the count is of passes judged on the build it serves (REQ-36 BC-18, BC-19)
function verifiedOf(r: Standing, t: Copy): string {
  const { proven, total, judgedOn } = r.verified;
  if (total === 0) return t("releases.standing.verified.unchecked");
  if (judgedOn && proven === 0) return t("releases.standing.verified.notJudgedOn", { environment: judgedOn, total });
  const met = proven === total ? t("releases.standing.verified.all", { n: total }) : t("releases.standing.verified.some", { proven, total });
  return judgedOn ? t("releases.standing.verified.onEnvironment", { met, environment: judgedOn }) : met;
}

const ENDED: readonly ReleaseState[] = ["failed", "aborted"];

/** Whether the owner's review waits on the judge: criteria not all passing on the testing environment (REQ-36 BC-18). */
function untested(r: Standing): string | null {
  const { proven, total, judgedOn } = r.verified;
  if (!judgedOn || total === 0 || proven === total) return null;
  return r.state === "landed" || (r.state === "awaiting_approval" && !r.approval?.decision) ? judgedOn : null;
}

function nextOf(r: Standing, t: Copy, goesSomewhere: boolean): string | null {
  if (r.state === "shipped") return null;
  const judgeOn = untested(r);
  if (judgeOn && (r.state !== "landed" || r.approvalRequired)) return t("releases.standing.next.judgeOn", { environment: judgeOn });
  if (r.state === "landed") return r.approvalRequired ? t("releases.standing.next.promote") : null;
  if (ENDED.includes(r.state)) return t("releases.standing.next.cutAgain");
  if (r.state === "returned") return t("releases.standing.next.returned");
  // a release the owner deploys ends at its last merge: once accepted, the agent merges it
  if (r.ownerDeploys && r.state === "in_progress") return t("releases.standing.next.merging");
  // a release with nowhere to go is refused at its cut and at its approval alike, so that comes first
  if (!goesSomewhere) return t(r.state === "draft" ? "releases.standing.next.environmentThenCut" : "releases.standing.next.environment");
  if (r.state === "draft") return t("releases.standing.next.cut");
  if (r.state === "awaiting_approval") return t("releases.standing.next.approve");
  return t("releases.standing.next.goingOut");
}

export function releaseStandingOf(r: Standing, t: Copy, date: (iso: string) => string): ReleaseStanding {
  const where = r.production?.name ?? r.production?.url ?? null;
  return {
    status: statusOf(r, t, date),
    approver: approverOf(r, t),
    goesTo: where ?? t(r.ownerDeploys ? "releases.standing.goesTo.ownerDeploys" : "releases.standing.goesTo.undeclared"),
    verified: verifiedOf(r, t),
    next: nextOf(r, t, where !== null || r.ownerDeploys),
  };
}

import { enumLabel, statusReading } from "@/design/vocabulary";
import { stampOf } from "./format";
import type { ReleaseEnvironmentRow, ReleaseVersionList, ReleaseVersionRow } from "./versions-types";

export type FlowStageKind = "draft" | "cut" | "approval" | "env" | "live";

export interface FlowStage {
  key: string;
  kind: FlowStageKind;
  label: string;
  tip: string;
  /** False for an environment the release run never acts on: no version is recorded there. */
  tracked: boolean;
  locked: boolean;
  env: ReleaseEnvironmentRow | null;
}

export interface ReleaseFlow {
  stages: FlowStage[];
  /** The stage a release run's promote, deploy and verify attempts belong to. */
  deployKey: string;
}

export type PlaceState = "current" | "waiting" | "failed" | "aborted" | "done";
export interface VersionPlace {
  at: string;
  state: PlaceState;
}

export type StepState = PlaceState | "passed" | "pending" | "untracked" | "skipped";

const TRIGGER_LABEL: Record<ReleaseEnvironmentRow["trigger"], string> = {
  "on-land": "deploys on land",
  "on-request": "deploys on request",
  provider: "the provider deploys",
  external: "deployed outside Forge",
};
export const triggerLabel = (t: ReleaseEnvironmentRow["trigger"]) => TRIGGER_LABEL[t];

export const APPROVER_TIP =
  "Approved by a person holding admin on this project, never an agent, and never the one who asked for it.";

export function flowOf(list: ReleaseVersionList): ReleaseFlow {
  const stages: FlowStage[] = [
    {
      key: "draft",
      kind: "draft",
      label: "Draft",
      tip: "Merged issues waiting at the release gate that no version holds yet",
      tracked: true,
      locked: false,
      env: null,
    },
    {
      key: "cut",
      kind: "cut",
      label: "Cut",
      tip: "A version is cut: its issues are fixed and its release run is open",
      tracked: true,
      locked: false,
      env: null,
    },
  ];
  if (list.approvalRequired || list.versions.some((v) => v.approval)) {
    stages.push({
      key: "approval",
      kind: "approval",
      label: "Approval",
      tip: list.approvalRequired
        ? `Required: no production act before an admin approves. ${APPROVER_TIP}`
        : `Not required on this project; a release run asked for one. ${APPROVER_TIP}`,
      tracked: true,
      locked: list.approvalRequired,
      env: null,
    });
  }
  let deployKey: string | null = null;
  for (const env of list.environments) {
    const production = env.tier === "production";
    const key = `env:${env.name}`;
    if (production && deployKey === null) deployKey = key;
    stages.push({
      key,
      kind: "env",
      label: env.name,
      tip: [
        env.tier,
        env.deploysFrom ? `from ${env.deploysFrom}` : null,
        triggerLabel(env.trigger),
        production
          ? "a release run's promote, deploy and verify act here"
          : "the issue path deploys here per issue; no version is recorded here",
        production ? (env.version ? `serving ${env.version}` : "nothing shipped yet") : null,
        env.url,
      ]
        .filter(Boolean)
        .join(" · "),
      tracked: production,
      locked: false,
      env,
    });
  }
  if (deployKey === null) {
    deployKey = "deploy";
    stages.push({
      key: "deploy",
      kind: "env",
      label: "Deploy",
      tip: "The project document declares no production environment; a release run's attempts are shown here",
      tracked: true,
      locked: false,
      env: null,
    });
  }
  stages.push({
    key: "live",
    kind: "live",
    label: "Live",
    tip: "Shipped: the release run stamped the version released",
    tracked: true,
    locked: false,
    env: null,
  });
  return { stages, deployKey };
}

export function placeOf(v: ReleaseVersionRow, flow: ReleaseFlow): VersionPlace {
  const acted = v.stages.length > 0;
  const lastFailed = v.stages.some((s) => s.settled && s.verdict === "failed");
  const before = acted ? flow.deployKey : v.approval ? "approval" : "cut";
  switch (v.status) {
    case "shipped":
      return { at: "live", state: "done" };
    case "awaiting_approval":
    case "returned":
      return { at: "approval", state: "waiting" };
    case "rolled_back":
    case "failed":
      return { at: before, state: "failed" };
    case "aborted":
      return { at: before, state: "aborted" };
    case "in_progress":
      if (acted) return { at: flow.deployKey, state: lastFailed ? "failed" : "current" };
      if (v.approval?.decision === "approved") return { at: flow.deployKey, state: "current" };
      return { at: "cut", state: "current" };
  }
}

export function stepStates(v: ReleaseVersionRow, flow: ReleaseFlow): StepState[] {
  const place = placeOf(v, flow);
  const at = flow.stages.findIndex((s) => s.key === place.at);
  return flow.stages.map((s, i) => {
    if (s.kind === "env" && !s.tracked) return "untracked";
    if (s.kind === "approval" && !s.locked && !v.approval && i < at) return "skipped";
    if (i < at) return "passed";
    if (i === at) return place.state;
    return "pending";
  });
}

export function stageCounts(list: ReleaseVersionList, flow: ReleaseFlow): Record<string, number> {
  const counts: Record<string, number> = Object.fromEntries(flow.stages.map((s) => [s.key, 0]));
  counts.draft = list.draft ? 1 : 0;
  for (const v of list.versions) counts[placeOf(v, flow).at] += 1;
  return counts;
}

const STEP_WORD: Record<StepState, string> = {
  current: "in progress",
  waiting: "waiting",
  failed: "failed",
  aborted: "aborted",
  done: "done",
  passed: "passed",
  pending: "not reached",
  untracked: "not recorded for a version",
  skipped: "not asked",
};

/** One line per stage for a version's tracker tooltip: what happened there, who, when. */
export function stepTip(v: ReleaseVersionRow, stage: FlowStage, state: StepState, deployKey: string): string {
  const head = `${stage.label}: ${STEP_WORD[state]}`;
  if (stage.kind === "draft") return head;
  if (stage.kind === "cut") return `${head} · cut ${stampOf(v.openedAt)} · ${v.issueCount} issues`;
  if (stage.kind === "approval") {
    const a = v.approval;
    if (!a) return v.approvalRequired ? `${head} · required, not asked yet` : head;
    const asked = `asked by ${a.requestedBy.name} ${stampOf(a.requestedAt)}`;
    if (!a.decision) return `${head} · ${asked}`;
    const by = `${statusReading("release", a.decision).label} by ${a.decidedBy?.name ?? "someone"}${a.decidedAt ? ` ${stampOf(a.decidedAt)}` : ""}`;
    return `${head} · ${asked} · ${by}${a.reason ? ` · ${a.reason}` : ""}`;
  }
  if (stage.key === deployKey) {
    if (v.stages.length === 0) return head;
    const parts = v.stages.map(
      (s) => `${enumLabel("attemptStage", s.stage)} ${s.settled ? (s.verdict ? statusReading("attemptVerdict", s.verdict).label.toLowerCase() : "settled") : "running"}`,
    );
    return `${head} · ${parts.join(" · ")}`;
  }
  if (stage.kind === "live") {
    if (!v.releasedAt) return head;
    return `${head} · released ${stampOf(v.releasedAt)}${v.current ? "" : " · superseded"}`;
  }
  return `${stage.label}: ${stage.tip}`;
}

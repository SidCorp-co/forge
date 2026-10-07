import type { QueryKey } from "@tanstack/react-query";
import { fireEvent } from "@testing-library/react";
import { AutomationScreen } from "@/features/automation/components/automation-screen";
import { FireItemScreen, ReportItemScreen, ScheduleItemScreen } from "@/features/automation/components/automation-item-screens";
import { FirePage, FirePeek } from "@/features/automation/components/fire-views";
import { ReportPage, ReportPeek } from "@/features/automation/components/report-views";
import { ScheduleForm } from "@/features/automation/components/schedule-form";
import { SchedulePage, SchedulePeek } from "@/features/automation/components/schedule-views";
import type { ScheduleRow } from "@/features/automation/schedule-types";
import type { FireStanding, ReportStanding, ScheduleStanding } from "@/features/automation/types";
import { Seeded } from "./vi-chrome-requirements";

// The Automation screens of the Development space for the vi walking test: the three tabs, a
// schedule's page and peek, a fire's, a report's with its triage forms. Names and summaries are
// placeholder words; core's own rule sentences are left as the placeholder "r".

const P = "p-auto";
const AT = "2026-10-07T08:00:00.000Z";
const noop = () => {};
const access = { projectId: P, slug: "hop", canWrite: true, canManage: true };
const peek = { open: "x", position: { at: 1, of: 3 }, set: noop, move: noop };
const wait = (kind: "you" | "person" | "issue" | "none", who: string, act: string) => ({ kind, who, act, rule: "r", ref: null, dueAt: null });
const none = wait("none", "", "");

const schedule = (id: string, over: Partial<ScheduleStanding> = {}): ScheduleStanding =>
  ({
    id,
    projectId: P,
    name: `lich-${id}`,
    kind: "prompt",
    cron: "0 9 * * 1-5",
    enabled: true,
    targetProjectSlug: null,
    state: "failing",
    rule: "r",
    nextFireAt: AT,
    owner: { id: "u1", name: "Lan" },
    streak: 2,
    lastFire: { id: "f1", status: "failed", trigger: "scheduled", startedAt: AT, finishedAt: AT, reason: null, refusal: null, sessionId: "s1" },
    viewerMay: { edit: true, takeOver: true },
    createdAt: AT,
    attentionGroup: "needs_you",
    waitingOn: wait("you", "You", "fix a failing schedule"),
    ...over,
  }) as unknown as ScheduleStanding;

const SCHEDULES = [
  schedule("s1"),
  schedule("s2", { state: "on", attentionGroup: "on", waitingOn: none, targetProjectSlug: "kho", lastFire: null, owner: null, kind: "script" }),
  schedule("s3", { state: "off", enabled: false, nextFireAt: null, attentionGroup: "off", waitingOn: wait("person", "The schedule owner", "take over a schedule whose owner is gone"), viewerMay: { edit: true, takeOver: false } }),
];

const produced = { reports: 2, newReports: 1, proposals: 1, issues: 0, runs: 1, notifications: 1 };
const fire = (id: string, over: Partial<FireStanding> = {}): FireStanding =>
  ({
    id: `${id}-fire-0001`,
    scheduleId: "s1",
    scheduleName: "lich-s1",
    trigger: "scheduled",
    status: "success",
    reason: null,
    refusal: null,
    error: null,
    disposition: null,
    sessionId: "s1-session",
    pipelineRunId: null,
    startedAt: AT,
    finishedAt: AT,
    durationSeconds: 125,
    produced,
    attentionGroup: "needs_you",
    waitingOn: wait("you", "You", "triage a report"),
    ...over,
  }) as unknown as FireStanding;

const FIRES = [
  fire("a"),
  fire("b", { status: "skipped", reason: "no-device" as never, trigger: "manual", durationSeconds: null, produced: { reports: 0, newReports: 0, proposals: 0, issues: 0, runs: 0, notifications: 0 }, attentionGroup: "failed_or_skipped", waitingOn: none, sessionId: null }),
  fire("c", { status: "running", durationSeconds: 42, attentionGroup: "running", waitingOn: none, produced: { ...produced, reports: 1, newReports: 0, proposals: 0, runs: 0, notifications: 0 } }),
];

const report = (id: string, over: Partial<ReportStanding> = {}): ReportStanding =>
  ({
    id: `${id}-report-0001`,
    projectId: P,
    projectSlug: "hop",
    issueId: null,
    runId: null,
    jobId: null,
    stage: null,
    kind: "friction",
    severity: "high",
    target: "skill",
    targetRef: "issue-flow",
    summary: "Tom tat bao cao",
    detail: "Chi tiet bao cao",
    suggestion: "Goi y sua",
    signalKey: "tin-hieu-1",
    sessionId: "s1-session",
    scheduleRunId: "a-fire-0001",
    triage: "new",
    triagedBy: null,
    triagedAt: null,
    triageReason: null,
    duplicateOf: null,
    linkedIssueId: null,
    feedback: null,
    createdAt: AT,
    fire: { id: "a-fire-0001", scheduleId: "s1", scheduleName: "lich-s1" },
    attentionGroup: "needs_you",
    waitingOn: wait("you", "You", "triage a report"),
    ...over,
  }) as unknown as ReportStanding;

const REPORTS = [
  report("a"),
  report("b", { triage: "filed", attentionGroup: "filed", linkedIssueId: "i1", waitingOn: wait("issue", "ISS-4", ""), triagedBy: { id: "u1", name: "Lan" }, triagedAt: AT, fire: null, stage: "build" }),
  report("c", { triage: "duplicate", attentionGroup: "closed", duplicateOf: "a-report-0001", triageReason: "Trung", triagedBy: { id: "u1", name: "Lan" }, triagedAt: AT, waitingOn: none }),
];

const standing = {
  generatedAt: AT,
  failStreak: 3,
  schedules: SCHEDULES,
  fires: FIRES,
  firesTotal: 120,
  firesHasMore: true,
  reports: REPORTS,
  reportCounts: { new: 1, filed: 1, dismissed: 0, duplicate: 1 },
  proposals: [],
};

const config = (s: ScheduleStanding): ScheduleRow =>
  ({ id: s.id, projectId: P, name: s.name, cron: s.cron, prompt: "Noi dung lenh", kind: s.kind, script: s.kind === "script" ? "echo xin-chao" : null, enabled: s.enabled, targetProjectSlug: s.targetProjectSlug, lastRunAt: AT, nextRunAt: AT, lastStatus: "failed", lastSessionId: null, params: null, createdAt: AT, updatedAt: AT }) as ScheduleRow;

const scheduleDetail = (s: ScheduleStanding) => ({ schedule: s, fires: FIRES.map((f) => ({ ...f, output: null })), firesTotal: 3, firesHasMore: false, reports: REPORTS, proposals: [] });

const fireDetail = {
  fire: { ...FIRES[0], output: "ket qua dau ra" },
  schedule: SCHEDULES[0],
  produced: {
    reports: [{ id: "a-report-0001", summary: "Tom tat bao cao", kind: "friction", severity: "high", triage: "new" }],
    proposals: [{ fireId: "a", scheduleId: "s1", scheduleName: "lich-s1", sessionId: "x", skill: "issue-flow", kind: "proposed", summary: "De xuat", at: AT }],
    issues: [{ id: "i1", key: "ISS-4", title: "Muc bon", status: "open" }],
    runs: [{ id: "r1-0000-0000", kind: "release", status: "running" }],
    notifications: [{ id: "n1", type: "schedule_report", title: "Thong bao", createdAt: AT }],
  },
};

const data = (): [QueryKey, unknown][] => [
  [["automation", P, "standing"], standing],
  [["automation", P, "schedule", "s1"], scheduleDetail(SCHEDULES[0] as ScheduleStanding)],
  [["automation", P, "schedule", "s3"], scheduleDetail(SCHEDULES[2] as ScheduleStanding)],
  [["automation", P, "fire", "a-fire-0001"], fireDetail],
  [["automation", P, "fire", "x"], { ...fireDetail, fire: { ...FIRES[1], output: null } }],
  [["automation", P, "report", "a-report-0001"], { report: REPORTS[0] }],
  [["automation", P, "report", "b-report-0001"], { report: REPORTS[1] }],
  [["schedules", P, "list"], SCHEDULES.map((s) => config(s as ScheduleStanding))],
];

const wrap = (children: React.ReactNode) => <Seeded data={data()}>{children}</Seeded>;

const clickAll = (selector: string) => () => {
  for (const el of document.querySelectorAll(selector)) fireEvent.click(el);
};

export const AUTOMATION_SCREENS = [
  { name: "Automation · schedules", render: () => wrap(<AutomationScreen access={access} />) },
  { name: "Automation · new schedule", render: () => wrap(<AutomationScreen access={access} />), act: clickAll('[data-testid="schedule-new"]') },
  {
    name: "Automation · schedule form",
    render: () => (
      <>
        <ScheduleForm submitLabel="x" pending={false} error={null} testId="a" onSubmit={noop} onCancel={noop} />
        {wrap(<ScheduleForm initial={config(SCHEDULES[1] as ScheduleStanding)} submitLabel="x" pending={false} error={null} testId="b" onSubmit={noop} onCancel={noop} />)}
      </>
    ),
  },
  { name: "Automation · schedule peek", render: () => wrap(<SchedulePeek s={SCHEDULES[0] as ScheduleStanding} access={access} peek={peek} onOpenFull={noop} />) },
  { name: "Automation · schedule peek · off", render: () => wrap(<SchedulePeek s={SCHEDULES[2] as ScheduleStanding} access={access} peek={peek} onOpenFull={noop} />) },
  { name: "Automation · schedule page", render: () => wrap(<ScheduleItemScreen access={access} scheduleId="s1" />) },
  { name: "Automation · schedule page · controls", render: () => wrap(<ScheduleItemScreen access={access} scheduleId="s3" />), act: clickAll('[data-testid="schedule-edit-open"],[data-testid="schedule-take-over"],[data-testid="schedule-delete"]') },
  { name: "Automation · schedule fires and reports", render: () => wrap(<SchedulePage access={access} scheduleId="s1" />) },
  { name: "Automation · fire peek", render: () => wrap(<FirePeek f={FIRES[0] as FireStanding} schedule={SCHEDULES[0] as ScheduleStanding} slug="hop" peek={peek} onOpenFull={noop} />) },
  { name: "Automation · fire page", render: () => wrap(<FireItemScreen access={access} fireId="a-fire-0001" />) },
  { name: "Automation · fire page · empty", render: () => wrap(<FirePage projectId={P} slug="hop" fireId="x" />) },
  { name: "Automation · report peek", render: () => wrap(<ReportPeek r={REPORTS[0] as ReportStanding} projectId={P} slug="hop" canWrite peek={peek} onOpenFull={noop} />), act: clickAll('[data-testid="report-dismiss-open"],[data-testid="report-duplicate-open"]') },
  { name: "Automation · report peek · filed", render: () => wrap(<ReportPeek r={REPORTS[1] as ReportStanding} projectId={P} slug="hop" canWrite peek={peek} onOpenFull={noop} />) },
  { name: "Automation · report page", render: () => wrap(<ReportItemScreen access={access} reportId="a-report-0001" />) },
  { name: "Automation · report page · filed", render: () => wrap(<ReportPage projectId={P} slug="hop" reportId="b-report-0001" canWrite={false} />) },
];

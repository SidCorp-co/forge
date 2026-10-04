"use client";

// cm:why a schedule as the automation read model serves it (ISS-116, design automation rev 1, step
// screen): its row, its facts rail, its peek and its full page read one ScheduleStanding, so the state,
// next fire, owner and last result are never derived here
import Link from "next/link";
import {
  Button,
  DetailLayout,
  DetailMobileTitle,
  DetailPane,
  DetailTabs,
  EnumBadge,
  ErrorState,
  Fact,
  FactsEmpty,
  FactsGroup,
  FactsRail,
  type ListRowView,
  MarkStrip,
  MonoTag,
  PeekHead,
  PeekPanel,
  type PeekState,
  PersonChip,
  ProjectLoader,
  StatusBadge,
  Toggle,
  useUrlTab,
  ViewHeading,
  WaitBanner,
  WaitingOn,
} from "@/design";
import { statusReading } from "@/design/vocabulary";
import { useRunSchedule, useSchedules, useSetScheduleEnabled } from "@/features/schedules/hooks";
import { formatApiError, formatRefusal, isRetryableApiError } from "@/lib/api/error";
import { formatAge, formatStamp } from "@/lib/utils/format";
import { useScheduleDetail } from "../hooks";
import { fireHref } from "../routes";
import type { ScheduleDetailResponse, ScheduleStanding } from "../types";
import { fmtTime } from "../view";
import { FireLines } from "./fire-views";
import { ReportLines } from "./report-views";

export interface AutomationAccess {
  projectId: string;
  slug: string;
  canWrite: boolean;
  canManage: boolean;
}

function whatItRuns(s: ScheduleStanding): string {
  if (s.targetProjectSlug) return `Runs on ${s.targetProjectSlug}`;
  return "Runs on this project";
}

export const scheduleRow =
  (hrefOf: (id: string) => string) =>
  (s: ScheduleStanding): ListRowView => ({
    key: s.id,
    keyLabel: s.name,
    href: hrefOf(s.id),
    title: whatItRuns(s),
    facts: [
      <EnumBadge key="kind" family="scheduleKind" value={s.kind} />,
      <span key="cron" className="font-mono">
        {s.cron}
      </span>,
      s.lastFire ? `Last fire ${statusReading("scheduleRun", s.lastFire.status).label.toLowerCase()}` : "Never fired",
    ],
    state: <StatusBadge family="scheduleStanding" value={s.state} />,
    waitingOn:
      s.waitingOn.kind === "none" ? (
        <span className="text-12-5 text-subtle">{s.nextFireAt ? `Next fire ${fmtTime(s.nextFireAt)}` : "Not scheduled"}</span>
      ) : (
        <WaitingOn w={s.waitingOn} />
      ),
    owner: s.owner?.name ?? "No owner",
    age: s.lastFire ? { text: formatAge(s.lastFire.startedAt), title: `Last fire ${formatStamp(s.lastFire.startedAt)}` } : null,
    dim: s.state === "off",
  });

/** The one primary act on a schedule: fire it now. Members may, as the server allows; a refusal reads by its code. */
export function RunNow({ s, access }: { s: ScheduleStanding; access: AutomationAccess }) {
  const run = useRunSchedule(access.projectId);
  if (!access.canWrite) return null;
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <Button
        type="button"
        variant="primary"
        size="sm"
        icon="play"
        disabled={run.isPending}
        onClick={() => run.mutate(s.id)}
        data-testid="schedule-run-now"
      >
        Run now
      </Button>
      {run.isError ? (
        <span className="text-12-5 text-danger" data-testid="run-now-refusal">
          {formatRefusal(run.error)}
        </span>
      ) : null}
    </span>
  );
}

export function ScheduleBanner({ s, className }: { s: ScheduleStanding; className?: string }) {
  if (s.waitingOn.kind === "none") return null;
  const w = s.waitingOn;
  const head = w.kind === "you" ? "Waiting on you:" : `Waiting on ${w.who}:`;
  return (
    <WaitBanner
      tone={s.state === "failing" ? "err" : "you"}
      head={`${statusReading("scheduleStanding", s.state).label} · ${head}`}
      body={w.act}
      rule={s.waitingOn.rule}
      className={className}
      testId="schedule-banner"
    >
      <span className="text-12-5 text-muted">{s.rule}</span>
    </WaitBanner>
  );
}

export function ScheduleFacts({ s, slug, failStreak }: { s: ScheduleStanding; slug: string; failStreak?: number }) {
  return (
    <>
      <FactsGroup title="Standing">
        <Fact label="State">
          <StatusBadge family="scheduleStanding" value={s.state} />
        </Fact>
        <Fact label="Streak">
          <span title={s.rule}>
            {s.streak}
            {failStreak ? <span className="text-subtle"> of {failStreak} to failing</span> : null}
          </span>
        </Fact>
        <Fact label="Last fire" testId="schedule-last-fire">
          {s.lastFire ? (
            <>
              <StatusBadge family="scheduleRun" value={s.lastFire.status} />
              <Link href={fireHref(slug, s.lastFire.id)} className="text-12-5 text-link hover:underline" title={formatStamp(s.lastFire.startedAt)}>
                {formatAge(s.lastFire.startedAt)} ago
              </Link>
            </>
          ) : (
            <span className="text-subtle">Never fired</span>
          )}
        </Fact>
      </FactsGroup>
      <FactsGroup title="Cadence">
        <Fact label="When">
          <MonoTag>{s.cron}</MonoTag>
        </Fact>
        <Fact label="Next fire" testId="schedule-next-fire">
          {s.nextFireAt ? <span title={formatStamp(s.nextFireAt)}>{fmtTime(s.nextFireAt)}</span> : <span className="text-subtle">Off</span>}
        </Fact>
      </FactsGroup>
      <FactsGroup title="Runs as">
        <Fact label="Owner" testId="schedule-owner">
          {s.owner ? <PersonChip name={s.owner.name ?? "Unnamed"} /> : <span className="text-subtle">No owner</span>}
        </Fact>
      </FactsGroup>
      <FactsGroup title="Properties">
        <Fact label="Kind">
          <EnumBadge family="scheduleKind" value={s.kind} />
        </Fact>
        <Fact label="Target">{s.targetProjectSlug ?? "This project"}</Fact>
        <Fact label="Created">
          <span title={formatStamp(s.createdAt)}>{new Date(s.createdAt).toLocaleDateString()}</span>
        </Fact>
      </FactsGroup>
    </>
  );
}

export function SchedulePeek({
  s,
  access,
  peek,
  onOpenFull,
}: {
  s: ScheduleStanding;
  access: AutomationAccess;
  peek: PeekState;
  onOpenFull: () => void;
}) {
  return (
    <PeekPanel peek={peek} listLabel="Automation" noun="Schedule" onOpenFull={onOpenFull} testId="schedule-peek">
      <PeekHead
        noun="Schedule"
        itemKey={s.name}
        badge={<StatusBadge family="scheduleStanding" value={s.state} />}
        title={whatItRuns(s)}
        action={<RunNow s={s} access={access} />}
      />
      <ScheduleBanner s={s} className="px-[18px]" />
      <div className="px-[18px] pb-4 pt-4">
        <ScheduleFacts s={s} slug={access.slug} />
      </div>
    </PeekPanel>
  );
}

export const SCHEDULE_TABS = ["overview", "fires", "reports"] as const;
export const useScheduleTab = () => useUrlTab(SCHEDULE_TABS);

function Controls({ s, access }: { s: ScheduleStanding; access: AutomationAccess }) {
  const setEnabled = useSetScheduleEnabled(access.projectId);
  if (!access.canManage) return null;
  return (
    <section>
      <ViewHeading>Controls</ViewHeading>
      <span className="inline-flex items-center gap-2 text-13">
        <Toggle
          checked={s.enabled}
          disabled={setEnabled.isPending}
          aria-label={`${s.enabled ? "Pause" : "Resume"} ${s.name}`}
          onChange={(enabled) => setEnabled.mutate({ id: s.id, enabled })}
        />
        {s.enabled ? "On: the ticker claims it at each due time" : "Paused: never claimed until resumed"}
      </span>
    </section>
  );
}

function WhatItRuns({ s, projectId }: { s: ScheduleStanding; projectId: string }) {
  const config = useSchedules(projectId).data?.find((r) => r.id === s.id);
  const body = config?.kind === "script" ? config.script : config?.prompt;
  return (
    <section>
      <ViewHeading>What it runs</ViewHeading>
      <p className="text-14">{whatItRuns(s)}</p>
      {body ? (
        <details className="mt-2">
          <summary className="cursor-pointer text-13 font-semibold text-muted">{config?.kind === "script" ? "Script" : "Prompt"}</summary>
          <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words bg-sunken p-3 text-12-5">{body}</pre>
        </details>
      ) : null}
    </section>
  );
}

function Overview({ d, access }: { d: ScheduleDetailResponse; access: AutomationAccess }) {
  const marks = [...d.fires].reverse().map((f) => ({
    key: f.id,
    label: `${statusReading("scheduleRun", f.status).label} · ${formatStamp(f.startedAt)}`,
    tone: statusReading("scheduleRun", f.status).tone,
  }));
  return (
    <div className="grid gap-8" data-testid="schedule-overview">
      <WhatItRuns s={d.schedule} projectId={access.projectId} />
      <section>
        <ViewHeading>Recent fires</ViewHeading>
        {marks.length ? (
          <span className="inline-flex items-center gap-2">
            <MarkStrip marks={marks} />
            <span className="text-12-5 text-subtle">{marks.length} shown, newest last</span>
          </span>
        ) : (
          <FactsEmpty>No fires yet.</FactsEmpty>
        )}
      </section>
      <Controls s={d.schedule} access={access} />
    </div>
  );
}

export function SchedulePage({ access, scheduleId }: { access: AutomationAccess; scheduleId: string }) {
  const q = useScheduleDetail(access.projectId, scheduleId, true);
  const [tab, setTab] = useScheduleTab();
  if (q.isLoading) {
    return (
      <div className="grid min-h-[40vh] place-items-center">
        <ProjectLoader label="loading the schedule…" />
      </div>
    );
  }
  if (q.isError || !q.data) {
    return (
      <div className="grid min-h-[40vh] place-items-center">
        <ErrorState message={formatApiError(q.error)} onRetry={isRetryableApiError(q.error) ? () => q.refetch() : undefined} />
      </div>
    );
  }
  const d = q.data;
  const s = d.schedule;
  const tabs = [
    { value: "overview" as const, label: "Overview" },
    { value: "fires" as const, label: "Fires", count: d.firesTotal },
    { value: "reports" as const, label: "Reports", count: d.reports.length },
  ];
  return (
    <DetailLayout
      testId="schedule-detail"
      dataKey={s.id}
      rail={
        <FactsRail>
          <ScheduleFacts s={s} slug={access.slug} />
        </FactsRail>
      }
    >
      <DetailMobileTitle itemKey={s.name} title={whatItRuns(s)} badge={<StatusBadge family="scheduleStanding" value={s.state} />} />
      <ScheduleBanner s={s} className="px-8 py-2.5 max-md:px-4" />
      <DetailTabs tabs={tabs} value={tab} onChange={setTab} testId="schedule-tabs" />
      <DetailPane label={tabs.find((t) => t.value === tab)?.label ?? "Overview"}>
        {tab === "overview" ? <Overview d={d} access={access} /> : null}
        {tab === "fires" ? <FireLines fires={d.fires} slug={access.slug} /> : null}
        {tab === "reports" ? <ReportLines reports={d.reports} slug={access.slug} /> : null}
      </DetailPane>
    </DetailLayout>
  );
}

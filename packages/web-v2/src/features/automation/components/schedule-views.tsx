"use client";

// a schedule as the automation read model serves it (ISS-116, design automation rev 1, step
// screen): its row, its facts rail, its peek and its full page read one ScheduleStanding, so the state,
// next fire, owner and last result are never derived here
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  Button,
  ConfirmDialog,
  DetailLayout,
  DetailMobileTitle,
  DetailPane,
  DetailTabs,
  EnumBadge,
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
  StatusBadge,
  Toggle,
  useUrlTab,
  ViewHeading,
  WaitBanner,
  WaitingOn,
} from "@/design";
import { QueryBoundary } from "@/lib/api/query-boundary";
import { statusReading } from "@/design/vocabulary";
import { useDeleteSchedule, useRunSchedule, useSchedules, useUpdateSchedule } from "@/features/automation/schedule-hooks";
import { formatRefusal } from "@/lib/api/error";
import { standingAct, standingWho } from "@/lib/i18n/standing-copy";
import type { Copy } from "@/lib/i18n/product-copy";
import { useCopy, useInterfaceLanguage, useTimeFormat } from "@/lib/i18n/interface-language";
import { useScheduleDetail } from "../hooks";
import { automationListHref, fireHref } from "@/lib/routes/automation";
import type { ScheduleDetailResponse, ScheduleStanding } from "../types";
import { fmtTime, type RowCtx } from "../view";
import { FireLines } from "./fire-views";
import { ReportLines } from "./report-views";
import { ScheduleForm } from "./schedule-form";

export interface AutomationAccess {
  projectId: string;
  slug: string;
  canWrite: boolean;
  /** project admin: may declare a new schedule. */
  canManage: boolean;
}

function whatItRuns(s: ScheduleStanding, t: Copy): string {
  if (s.targetProjectSlug) return t("schedules.runsOn", { slug: s.targetProjectSlug });
  return t("schedules.runsOnThis");
}

export const scheduleRow =
  (hrefOf: (id: string) => string, { t, language, time }: RowCtx) =>
  (s: ScheduleStanding): ListRowView => ({
    key: s.id,
    keyLabel: s.name,
    href: hrefOf(s.id),
    title: whatItRuns(s, t),
    facts: [
      <EnumBadge key="kind" family="scheduleKind" value={s.kind} />,
      <span key="cron" className="font-mono">
        {s.cron}
      </span>,
      s.lastFire ? t("schedules.lastFire", { status: statusReading("scheduleRun", s.lastFire.status, language).label.toLowerCase() }) : t("schedules.neverFired"),
    ],
    state: <StatusBadge family="scheduleStanding" value={s.state} />,
    waitingOn:
      s.waitingOn.kind === "none" ? (
        <span className="text-12-5 text-subtle">{s.nextFireAt ? t("schedules.nextFire", { at: fmtTime(s.nextFireAt, language) }) : t("schedules.notScheduled")}</span>
      ) : (
        <WaitingOn w={s.waitingOn} />
      ),
    owner: s.owner?.name ?? t("schedules.noOwner"),
    age: s.lastFire ? { text: time.age(s.lastFire.startedAt), title: t("schedules.lastFireAt", { at: time.dateTime(s.lastFire.startedAt) }) } : null,
    dim: s.state === "off",
  });

/** The one primary act on a schedule: fire it now. Members may, as the server allows; a refusal reads by its code. */
export function RunNow({ s, access }: { s: ScheduleStanding; access: AutomationAccess }) {
  const t = useCopy();
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
        {t("schedules.runNow")}
      </Button>
      {run.isError ? (
        <span className="text-12-5 text-danger" data-testid="run-now-refusal">
          {formatRefusal(run.error)}
        </span>
      ) : null}
    </span>
  );
}

function ScheduleBanner({ s, className }: { s: ScheduleStanding; className?: string }) {
  const t = useCopy();
  const language = useInterfaceLanguage();
  if (s.waitingOn.kind === "none") return null;
  const w = s.waitingOn;
  const head = w.kind === "you" ? t("schedules.waitingOnYou") : t("schedules.waitingOnWho", { who: standingWho(w.who, language) });
  return (
    <WaitBanner
      tone={s.state === "failing" ? "err" : "you"}
      head={`${statusReading("scheduleStanding", s.state, language).label} · ${head}`}
      body={standingAct(w.act, language)}
      rule={s.waitingOn.rule}
      className={className}
      testId="schedule-banner"
    >
      <span className="text-12-5 text-muted">{s.rule}</span>
    </WaitBanner>
  );
}

export function ScheduleFacts({ s, slug, failStreak }: { s: ScheduleStanding; slug: string; failStreak?: number }) {
  const t = useCopy();
  const time = useTimeFormat();
  return (
    <>
      <FactsGroup title={t("schedules.facts.standing")}>
        <Fact label={t("schedules.facts.state")}>
          <StatusBadge family="scheduleStanding" value={s.state} />
        </Fact>
        <Fact label={t("schedules.facts.streak")}>
          <span title={s.rule}>
            {s.streak}
            {failStreak ? <span className="text-subtle"> {t("schedules.facts.ofToFailing", { n: failStreak })}</span> : null}
          </span>
        </Fact>
        <Fact label={t("schedules.facts.lastFire")} testId="schedule-last-fire">
          {s.lastFire ? (
            <>
              <StatusBadge family="scheduleRun" value={s.lastFire.status} />
              <Link href={fireHref(slug, s.lastFire.id)} className="text-12-5 text-link hover:underline" title={time.dateTime(s.lastFire.startedAt)}>
                {t("schedules.ago", { age: time.age(s.lastFire.startedAt) })}
              </Link>
            </>
          ) : (
            <span className="text-subtle">{t("schedules.neverFired")}</span>
          )}
        </Fact>
      </FactsGroup>
      <FactsGroup title={t("schedules.facts.cadence")}>
        <Fact label={t("schedules.facts.when")}>
          <MonoTag>{s.cron}</MonoTag>
        </Fact>
        <Fact label={t("schedules.facts.nextFire")} testId="schedule-next-fire">
          {s.nextFireAt ? <span title={time.dateTime(s.nextFireAt)}>{time.dateTime(s.nextFireAt)}</span> : <span className="text-subtle">{t("schedules.facts.off")}</span>}
        </Fact>
      </FactsGroup>
      <FactsGroup title={t("schedules.facts.runsAs")}>
        <Fact label={t("schedules.facts.owner")} testId="schedule-owner">
          {s.owner ? <PersonChip name={s.owner.name ?? t("schedules.facts.unnamed")} /> : <span className="text-subtle">{t("schedules.noOwner")}</span>}
        </Fact>
      </FactsGroup>
      <FactsGroup title={t("schedules.facts.properties")}>
        <Fact label={t("schedules.facts.kind")}>
          <EnumBadge family="scheduleKind" value={s.kind} />
        </Fact>
        <Fact label={t("schedules.facts.target")}>{s.targetProjectSlug ?? t("schedules.facts.thisProject")}</Fact>
        <Fact label={t("schedules.facts.created")}>
          <span title={time.dateTime(s.createdAt)}>{time.date(s.createdAt)}</span>
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
  const t = useCopy();
  return (
    <PeekPanel peek={peek} listLabel={t("schedules.title")} noun={t("schedules.noun.schedule")} onOpenFull={onOpenFull} testId="schedule-peek">
      <PeekHead
        noun={t("schedules.noun.schedule")}
        itemKey={s.name}
        badge={<StatusBadge family="scheduleStanding" value={s.state} />}
        title={whatItRuns(s, t)}
        action={<RunNow s={s} access={access} />}
      />
      <ScheduleBanner s={s} className="px-[18px]" />
      <div className="px-[18px] pb-4 pt-4">
        <ScheduleFacts s={s} slug={access.slug} />
      </div>
    </PeekPanel>
  );
}

const SCHEDULE_TABS = ["overview", "fires", "reports"] as const;
const useScheduleTab = () => useUrlTab(SCHEDULE_TABS);

/** Pause, edit, take over or delete: its owner for their own, an admin for any (the read model says which). */
function Controls({ s, access }: { s: ScheduleStanding; access: AutomationAccess }) {
  const t = useCopy();
  const update = useUpdateSchedule(access.projectId);
  const takeOver = useUpdateSchedule(access.projectId, "schedules.toast.takenOver");
  const remove = useDeleteSchedule(access.projectId);
  const router = useRouter();
  const config = useSchedules(access.projectId).data?.find((r) => r.id === s.id);
  const [editing, setEditing] = useState(false);
  const [confirm, setConfirm] = useState<"take_over" | "delete" | null>(null);
  if (!s.viewerMay.edit) return null;
  return (
    <section data-testid="schedule-controls">
      <ViewHeading>{t("schedules.controls")}</ViewHeading>
      <div className="grid gap-3">
        <span className="inline-flex items-center gap-2 text-13">
          <Toggle
            checked={s.enabled}
            disabled={update.isPending}
            aria-label={t(s.enabled ? "schedules.pause" : "schedules.resume", { name: s.name })}
            onChange={(enabled) => update.mutate({ id: s.id, patch: { enabled } })}
          />
          {s.enabled ? t("schedules.isOn") : t("schedules.isPaused")}
        </span>
        {s.viewerMay.takeOver ? (
          <p className="text-12-5 text-muted">{t("schedules.takeOverNote")}</p>
        ) : null}
        {editing && config ? (
          <ScheduleForm
            initial={config}
            submitLabel={t("schedules.save")}
            pending={update.isPending}
            error={update.error}
            testId="schedule-edit"
            onCancel={() => setEditing(false)}
            onSubmit={(input) => update.mutate({ id: s.id, patch: input }, { onSuccess: () => setEditing(false) })}
          />
        ) : (
          <span className="inline-flex flex-wrap items-center gap-2">
            <Button type="button" size="sm" disabled={!config} onClick={() => setEditing(true)} data-testid="schedule-edit-open">
              {t("schedules.edit")}
            </Button>
            {s.viewerMay.takeOver ? (
              <Button type="button" size="sm" onClick={() => setConfirm("take_over")} data-testid="schedule-take-over">
                {t("schedules.takeOver")}
              </Button>
            ) : null}
            <Button type="button" size="sm" variant="ghost" onClick={() => setConfirm("delete")} data-testid="schedule-delete">
              {t("schedules.delete")}
            </Button>
          </span>
        )}
      </div>
      <ConfirmDialog
        open={confirm === "take_over"}
        title={t("schedules.takeOverTitle", { name: s.name })}
        message={t("schedules.takeOverMessage")}
        confirmLabel={t("schedules.takeOver")}
        loading={takeOver.isPending}
        onClose={() => setConfirm(null)}
        onConfirm={() => takeOver.mutate({ id: s.id, patch: { enabled: s.enabled } }, { onSettled: () => setConfirm(null) })}
      />
      <ConfirmDialog
        open={confirm === "delete"}
        title={t("schedules.deleteTitle", { name: s.name })}
        message={t("schedules.deleteMessage")}
        confirmLabel={t("schedules.delete")}
        tone="danger"
        loading={remove.isPending}
        onClose={() => setConfirm(null)}
        onConfirm={() =>
          remove.mutate(s.id, {
            onSuccess: () => router.push(automationListHref(access.slug)),
            onSettled: () => setConfirm(null),
          })
        }
      />
    </section>
  );
}

function WhatItRuns({ s, projectId }: { s: ScheduleStanding; projectId: string }) {
  const t = useCopy();
  const config = useSchedules(projectId).data?.find((r) => r.id === s.id);
  const body = config?.kind === "script" ? config.script : config?.prompt;
  return (
    <section>
      <ViewHeading>{t("schedules.whatItRuns")}</ViewHeading>
      <p className="text-14">{whatItRuns(s, t)}</p>
      {body ? (
        <details className="mt-2">
          <summary className="cursor-pointer text-13 font-semibold text-muted">{config?.kind === "script" ? t("schedules.script") : t("schedules.prompt")}</summary>
          <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words bg-sunken p-3 text-12-5">{body}</pre>
        </details>
      ) : null}
    </section>
  );
}

function Overview({ d, access }: { d: ScheduleDetailResponse; access: AutomationAccess }) {
  const t = useCopy();
  const language = useInterfaceLanguage();
  const time = useTimeFormat();
  const marks = [...d.fires].reverse().map((f) => ({
    key: f.id,
    label: `${statusReading("scheduleRun", f.status, language).label} · ${time.dateTime(f.startedAt)}`,
    tone: statusReading("scheduleRun", f.status, language).tone,
  }));
  return (
    <div className="grid gap-8" data-testid="schedule-overview">
      <WhatItRuns s={d.schedule} projectId={access.projectId} />
      <section>
        <ViewHeading>{t("schedules.recentFires")}</ViewHeading>
        {marks.length ? (
          <span className="inline-flex items-center gap-2">
            <MarkStrip marks={marks} />
            <span className="text-12-5 text-subtle">{t("schedules.shownNewestLast", { n: marks.length })}</span>
          </span>
        ) : (
          <FactsEmpty>{t("schedules.noFires")}</FactsEmpty>
        )}
      </section>
      <Controls s={d.schedule} access={access} />
    </div>
  );
}

export function SchedulePage({ access, scheduleId }: { access: AutomationAccess; scheduleId: string }) {
  const t = useCopy();
  const q = useScheduleDetail(access.projectId, scheduleId, true);
  const [tab, setTab] = useScheduleTab();
  return (
    <QueryBoundary query={q} loadingLabel={t("schedules.loadingSchedule")}>
      {(data) => {
        const d = data;
        const s = d.schedule;
        const tabs = [
          { value: "overview" as const, label: t("schedules.tab.overview") },
          { value: "fires" as const, label: t("schedules.tab.fires"), count: d.firesTotal },
          { value: "reports" as const, label: t("schedules.tab.reports"), count: d.reports.length },
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
            <DetailMobileTitle itemKey={s.name} title={whatItRuns(s, t)} badge={<StatusBadge family="scheduleStanding" value={s.state} />} />
            <ScheduleBanner s={s} className="px-8 py-2.5 max-md:px-4" />
            <DetailTabs tabs={tabs} value={tab} onChange={setTab} testId="schedule-tabs" />
            <DetailPane label={tabs.find((x) => x.value === tab)?.label ?? t("schedules.tab.overview")}>
              {tab === "overview" ? <Overview d={d} access={access} /> : null}
              {tab === "fires" ? <FireLines fires={d.fires} slug={access.slug} /> : null}
              {tab === "reports" ? <ReportLines reports={d.reports} slug={access.slug} /> : null}
            </DetailPane>
          </DetailLayout>
        );
      }}
    </QueryBoundary>
  );
}

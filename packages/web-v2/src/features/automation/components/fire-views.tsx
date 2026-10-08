"use client";

// a fire as the automation read model serves it (ISS-116, design automation rev 1, steps
// settle and screen): its result, why, and what it produced are counted and joined by core, so the
// Fires tab and the fire page only lay them out
import Link from "next/link";
import {
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
  PeekHead,
  PeekPanel,
  type PeekState,
  StatusBadge,
  useUrlTab,
  ViewHeading,
  WaitBanner,
  WaitingOn,
} from "@/design";
import { QueryBoundary } from "@/lib/api/query-boundary";
import { enumLabel } from "@/design/vocabulary";
import { issueHref } from "@/lib/routes/issues";
import { useCopy, useInterfaceLanguage, useTimeFormat } from "@/lib/i18n/interface-language";
import { said } from "@/lib/i18n/said";
import { useFireDetail } from "../hooks";
import { fireHref, reportHref, scheduleHref, sessionHref } from "@/lib/routes/automation";
import type { FireDetailResponse, FireStanding } from "../types";
import { fireWhy, fmtDuration, producedLine, type RowCtx, shortId } from "../view";

export const fireRow =
  (hrefOf: (id: string) => string, { t, language, time }: RowCtx) =>
  (f: FireStanding): ListRowView => {
    const why = fireWhy(f, language);
    return {
      key: f.id,
      keyLabel: `#${shortId(f.id)}`,
      href: hrefOf(f.id),
      title: f.scheduleName,
      facts: [enumLabel("fireTrigger", f.trigger, language), fmtDuration(f.durationSeconds, t), producedLine(f.produced, t), ...(why ? [why] : [])],
      state: <StatusBadge family="scheduleRun" value={f.status} />,
      waitingOn: f.waitingOn.kind === "none" ? <span className="text-12-5 text-subtle">—</span> : <WaitingOn w={f.waitingOn} />,
      owner: enumLabel("fireTrigger", f.trigger, language),
      age: { text: time.age(f.startedAt), title: t("schedules.fire.started", { at: time.dateTime(f.startedAt) }) },
      dim: f.attentionGroup === "nothing_produced",
    };
  };

/** A schedule's fires as hairline rows, each opening the fire's page. */
export function FireLines({ fires, slug }: { fires: readonly FireStanding[]; slug: string }) {
  const t = useCopy();
  const language = useInterfaceLanguage();
  const time = useTimeFormat();
  if (fires.length === 0) return <FactsEmpty>{t("schedules.noFires")}</FactsEmpty>;
  return (
    <ul className="border-t border-line-subtle" data-testid="fire-lines">
      {fires.map((f) => {
        const why = fireWhy(f, language);
        return (
          <li key={f.id} className="border-b border-line-subtle">
            <Link href={fireHref(slug, f.id)} className="flex flex-wrap items-center gap-2 py-2 text-13 hover:bg-hover">
              <span className="font-mono text-12 font-semibold text-link">#{shortId(f.id)}</span>
              <StatusBadge family="scheduleRun" value={f.status} />
              <span className="text-muted">{enumLabel("fireTrigger", f.trigger, language)}</span>
              <span className="font-mono text-12 text-subtle">{fmtDuration(f.durationSeconds, t)}</span>
              <span className="text-muted">{producedLine(f.produced, t)}</span>
              {why ? <span className="truncate text-danger">{why}</span> : null}
              <span className="ml-auto font-mono text-11 text-subtle" title={time.dateTime(f.startedAt)}>
                {time.age(f.startedAt)}
              </span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

function FireBanner({ f, className }: { f: FireStanding; className?: string }) {
  const t = useCopy();
  const language = useInterfaceLanguage();
  if (f.waitingOn.kind === "none") return null;
  const w = f.waitingOn;
  return (
    <WaitBanner
      tone="you"
      head={w.kind === "you" ? t("schedules.waitingOnYou") : t("schedules.waitingOnWho", { who: said(w.says.who, language) })}
      body={said(w.says.act, language)}
      rule={said(w.says.rule, language)}
      className={className}
      testId="fire-banner"
    />
  );
}

export function FireFacts({ d, slug }: { d: Pick<FireDetailResponse, "fire" | "schedule">; slug: string }) {
  const t = useCopy();
  const language = useInterfaceLanguage();
  const time = useTimeFormat();
  const f = d.fire;
  const why = fireWhy(f, language);
  return (
    <>
      <FactsGroup title={t("schedules.fire.result")}>
        <Fact label={t("schedules.fire.status")}>
          <StatusBadge family="scheduleRun" value={f.status} />
        </Fact>
        {why ? (
          <Fact label={t("schedules.fire.why")}>
            <span className="text-danger" title={f.refusal ?? f.error ?? f.reason ?? undefined} data-value={f.refusal ?? f.error ?? f.reason ?? undefined}>
              {why}
            </span>
          </Fact>
        ) : null}
        <Fact label={t("schedules.fire.startedLabel")}>
          <span title={time.dateTime(f.startedAt)}>{t("schedules.ago", { age: time.age(f.startedAt) })}</span>
        </Fact>
        <Fact label={t("schedules.fire.took")}>{fmtDuration(f.durationSeconds, t)}</Fact>
        <Fact label={t("schedules.fire.trigger")}>
          <EnumBadge family="fireTrigger" value={f.trigger} />
        </Fact>
      </FactsGroup>
      <FactsGroup title={t("schedules.fire.produced")}>
        <Fact label={t("schedules.fire.counted")} testId="fire-produced">
          {producedLine(f.produced, t)}
        </Fact>
      </FactsGroup>
      <FactsGroup title={t("schedules.fire.source")}>
        <Fact label={t("schedules.fire.schedule")}>
          <Link href={scheduleHref(slug, d.schedule.id)} className="text-link hover:underline">
            {d.schedule.name}
          </Link>
          <StatusBadge family="scheduleStanding" value={d.schedule.state} />
        </Fact>
        {f.runAs ? (
          <Fact label={t("schedules.fire.ranAs")} testId="fire-ran-as">
            {f.runAs.name ?? shortId(f.runAs.id)}
          </Fact>
        ) : null}
        {f.sessionId ? (
          <Fact label={t("schedules.fire.session")}>
            <Link href={sessionHref(slug, f.sessionId)} className="font-mono text-12-5 text-link hover:underline">
              {shortId(f.sessionId)}
            </Link>
          </Fact>
        ) : null}
      </FactsGroup>
      {f.reads ? (
        <FactsGroup title={t("schedules.fire.reads")}>
          <FireReads reads={f.reads} />
        </FactsGroup>
      ) : null}
    </>
  );
}

/** Each read a script fire made, in order, as hairline rows: method, path and the status it answered, or the refusal that stopped it. */
function FireReads({ reads }: { reads: NonNullable<FireStanding["reads"]> }) {
  const t = useCopy();
  if (reads.length === 0) return <span className="text-13 text-subtle">{t("schedules.fire.readNothing")}</span>;
  return (
    <ul className="border-t border-line-subtle" data-testid="fire-reads">
      {reads.map((r, i) => (
        // the same path can be read twice in one run, so the position is part of what a read is
        // biome-ignore lint/suspicious/noArrayIndexKey: a run's reads are fixed once recorded
        <li key={`${i}:${r.method}:${r.path}`} className="flex flex-wrap items-baseline gap-x-2 border-b border-line-subtle py-1.5 text-12-5">
          <span className="font-mono font-semibold">{r.method}</span>
          <span className="min-w-0 break-all font-mono text-muted">{r.path}</span>
          {r.refused ? (
            <span className="ml-auto text-danger" data-testid="fire-read-refused">
              {t("schedules.fire.readRefused", { code: r.refused })}
            </span>
          ) : (
            <span className="ml-auto font-mono text-subtle">{r.status}</span>
          )}
        </li>
      ))}
    </ul>
  );
}

export function FirePeek({
  f,
  schedule,
  slug,
  peek,
  onOpenFull,
}: {
  f: FireStanding;
  schedule: FireDetailResponse["schedule"] | undefined;
  slug: string;
  peek: PeekState;
  onOpenFull: () => void;
}) {
  const t = useCopy();
  return (
    <PeekPanel peek={peek} listLabel={t("schedules.title")} noun={t("schedules.noun.fire")} onOpenFull={onOpenFull} testId="fire-peek">
      <PeekHead noun={t("schedules.noun.fire")} itemKey={`#${shortId(f.id)}`} badge={<StatusBadge family="scheduleRun" value={f.status} />} title={f.scheduleName} />
      <FireBanner f={f} className="px-[18px]" />
      <div className="px-[18px] pb-4 pt-4">
        {schedule ? <FireFacts d={{ fire: { ...f, output: null }, schedule }} slug={slug} /> : null}
      </div>
    </PeekPanel>
  );
}

const FIRE_TABS = ["produced", "output"] as const;

function Produced({ d, slug }: { d: FireDetailResponse; slug: string }) {
  const t = useCopy();
  const language = useInterfaceLanguage();
  const time = useTimeFormat();
  const p = d.produced;
  const empty = !p.reports.length && !p.issues.length && !p.proposals.length && !p.runs.length && !p.notifications.length;
  if (empty) return <FactsEmpty>{t("schedules.fire.nothing")}</FactsEmpty>;
  return (
    <div className="grid gap-8" data-testid="fire-produced-items">
      {p.reports.length ? (
        <section>
          <ViewHeading hint={`${p.reports.length}`}>{t("schedules.fire.reports")}</ViewHeading>
          <ul className="border-t border-line-subtle">
            {p.reports.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-2 border-b border-line-subtle py-2 text-13">
                <StatusBadge family="reportTriage" value={r.triage} />
                <Link href={reportHref(slug, r.id)} className="text-link hover:underline">
                  {r.summary}
                </Link>
                <span className="text-subtle">{enumLabel("agentReportKind", r.kind, language)}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {p.issues.length ? (
        <section>
          <ViewHeading hint={`${p.issues.length}`}>{t("schedules.fire.issues")}</ViewHeading>
          <ul className="border-t border-line-subtle">
            {p.issues.map((i) => (
              <li key={i.id} className="flex flex-wrap items-center gap-2 border-b border-line-subtle py-2 text-13">
                <Link href={issueHref(slug, i.key)} className="font-mono text-12-5 font-semibold text-link hover:underline">
                  {i.key}
                </Link>
                <span>{i.title}</span>
                <StatusBadge family="issue" value={i.status} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {p.proposals.length ? (
        <section>
          <ViewHeading hint={`${p.proposals.length}`}>{t("schedules.fire.proposals")}</ViewHeading>
          <ul className="border-t border-line-subtle">
            {p.proposals.map((a) => (
              <li key={`${a.skill}:${a.summary}`} className="flex flex-wrap items-center gap-2 border-b border-line-subtle py-2 text-13">
                <StatusBadge family="stewardAction" value={a.kind} />
                <span className="font-mono text-12-5">{a.skill}</span>
                <span className="text-muted">{a.summary}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {p.runs.length ? (
        <section>
          <ViewHeading hint={`${p.runs.length}`}>{t("schedules.fire.runs")}</ViewHeading>
          <ul className="border-t border-line-subtle">
            {p.runs.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-2 border-b border-line-subtle py-2 text-13">
                <span className="font-mono text-12-5">{shortId(r.id)}</span>
                <span className="text-muted">{r.kind}</span>
                <StatusBadge family="pipelineRun" value={r.status} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {p.notifications.length ? (
        <section>
          <ViewHeading hint={`${p.notifications.length}`}>{t("schedules.fire.notifications")}</ViewHeading>
          <ul className="border-t border-line-subtle">
            {p.notifications.map((n) => (
              <li key={n.id} className="flex flex-wrap items-center gap-2 border-b border-line-subtle py-2 text-13">
                <EnumBadge family="notificationType" value={n.type} />
                <span>{n.title}</span>
                <span className="ml-auto font-mono text-11 text-subtle" title={time.dateTime(n.createdAt)}>
                  {time.age(n.createdAt)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

export function FirePage({ projectId, slug, fireId }: { projectId: string; slug: string; fireId: string }) {
  const t = useCopy();
  const q = useFireDetail(projectId, fireId);
  const [tab, setTab] = useUrlTab(FIRE_TABS);
  return (
    <QueryBoundary query={q} loadingLabel={t("schedules.fire.loading")}>
      {(data) => {
        const d = data;
        const tabs = [
          { value: "produced" as const, label: t("schedules.fire.produced") },
          { value: "output" as const, label: t("schedules.fire.output") },
        ];
        return (
          <DetailLayout
            testId="fire-detail"
            dataKey={d.fire.id}
            rail={
              <FactsRail>
                <FireFacts d={d} slug={slug} />
              </FactsRail>
            }
          >
            <DetailMobileTitle itemKey={`#${shortId(d.fire.id)}`} title={d.fire.scheduleName} badge={<StatusBadge family="scheduleRun" value={d.fire.status} />} />
            <FireBanner f={d.fire} className="px-8 py-2.5 max-md:px-4" />
            <DetailTabs tabs={tabs} value={tab} onChange={setTab} testId="fire-tabs" />
            <DetailPane label={tab === "output" ? t("schedules.fire.output") : t("schedules.fire.produced")}>
              {tab === "produced" ? (
                <Produced d={d} slug={slug} />
              ) : d.fire.output ? (
                <pre className="max-h-[70vh] overflow-auto whitespace-pre-wrap break-words bg-sunken p-3 text-12-5" data-testid="fire-output">
                  {d.fire.output}
                </pre>
              ) : (
                <FactsEmpty>{d.fire.sessionId ? t("schedules.fire.outputIsTranscript") : t("schedules.fire.noOutput")}</FactsEmpty>
              )}
            </DetailPane>
          </DetailLayout>
        );
      }}
    </QueryBoundary>
  );
}

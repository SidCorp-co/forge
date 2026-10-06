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
  ErrorState,
  Fact,
  FactsEmpty,
  FactsGroup,
  FactsRail,
  type ListRowView,
  PeekHead,
  PeekPanel,
  type PeekState,
  ProjectLoader,
  StatusBadge,
  useUrlTab,
  ViewHeading,
  WaitBanner,
  WaitingOn,
} from "@/design";
import { enumLabel } from "@/design/vocabulary";
import { issueHref } from "@/lib/routes/issues";
import { formatApiError, isRetryableApiError } from "@/lib/api/error";
import { formatAge, formatStamp } from "@/lib/utils/format";
import { useFireDetail } from "../hooks";
import { fireHref, reportHref, scheduleHref, sessionHref } from "@/lib/routes/automation";
import type { FireDetailResponse, FireStanding } from "../types";
import { fireWhy, fmtDuration, producedLine, shortId } from "../view";

export const fireRow =
  (hrefOf: (id: string) => string) =>
  (f: FireStanding): ListRowView => {
    const why = fireWhy(f);
    return {
      key: f.id,
      keyLabel: `#${shortId(f.id)}`,
      href: hrefOf(f.id),
      title: f.scheduleName,
      facts: [enumLabel("fireTrigger", f.trigger), fmtDuration(f.durationSeconds), producedLine(f.produced), ...(why ? [why] : [])],
      state: <StatusBadge family="scheduleRun" value={f.status} />,
      waitingOn: f.waitingOn.kind === "none" ? <span className="text-12-5 text-subtle">—</span> : <WaitingOn w={f.waitingOn} />,
      owner: enumLabel("fireTrigger", f.trigger),
      age: { text: formatAge(f.startedAt), title: `Started ${formatStamp(f.startedAt)}` },
      dim: f.attentionGroup === "nothing_produced",
    };
  };

/** A schedule's fires as hairline rows, each opening the fire's page. */
export function FireLines({ fires, slug }: { fires: readonly FireStanding[]; slug: string }) {
  if (fires.length === 0) return <FactsEmpty>No fires yet.</FactsEmpty>;
  return (
    <ul className="border-t border-line-subtle" data-testid="fire-lines">
      {fires.map((f) => {
        const why = fireWhy(f);
        return (
          <li key={f.id} className="border-b border-line-subtle">
            <Link href={fireHref(slug, f.id)} className="flex flex-wrap items-center gap-2 py-2 text-13 hover:bg-hover">
              <span className="font-mono text-12 font-semibold text-link">#{shortId(f.id)}</span>
              <StatusBadge family="scheduleRun" value={f.status} />
              <span className="text-muted">{enumLabel("fireTrigger", f.trigger)}</span>
              <span className="font-mono text-12 text-subtle">{fmtDuration(f.durationSeconds)}</span>
              <span className="text-muted">{producedLine(f.produced)}</span>
              {why ? <span className="truncate text-danger">{why}</span> : null}
              <span className="ml-auto font-mono text-11 text-subtle" title={formatStamp(f.startedAt)}>
                {formatAge(f.startedAt)}
              </span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

function FireBanner({ f, className }: { f: FireStanding; className?: string }) {
  if (f.waitingOn.kind === "none") return null;
  const w = f.waitingOn;
  return (
    <WaitBanner
      tone="you"
      head={w.kind === "you" ? "Waiting on you:" : `Waiting on ${w.who}:`}
      body={w.act}
      rule={f.waitingOn.rule}
      className={className}
      testId="fire-banner"
    />
  );
}

export function FireFacts({ d, slug }: { d: Pick<FireDetailResponse, "fire" | "schedule">; slug: string }) {
  const f = d.fire;
  const why = fireWhy(f);
  return (
    <>
      <FactsGroup title="Result">
        <Fact label="Status">
          <StatusBadge family="scheduleRun" value={f.status} />
        </Fact>
        {why ? (
          <Fact label="Why">
            <span className="text-danger" title={f.refusal ?? f.error ?? f.reason ?? undefined}>
              {why}
            </span>
          </Fact>
        ) : null}
        <Fact label="Started">
          <span title={formatStamp(f.startedAt)}>{formatAge(f.startedAt)} ago</span>
        </Fact>
        <Fact label="Took">{fmtDuration(f.durationSeconds)}</Fact>
        <Fact label="Trigger">
          <EnumBadge family="fireTrigger" value={f.trigger} />
        </Fact>
      </FactsGroup>
      <FactsGroup title="Produced">
        <Fact label="Counted" testId="fire-produced">
          {producedLine(f.produced)}
        </Fact>
      </FactsGroup>
      <FactsGroup title="Source">
        <Fact label="Schedule">
          <Link href={scheduleHref(slug, d.schedule.id)} className="text-link hover:underline">
            {d.schedule.name}
          </Link>
          <StatusBadge family="scheduleStanding" value={d.schedule.state} />
        </Fact>
        {f.sessionId ? (
          <Fact label="Session">
            <Link href={sessionHref(slug, f.sessionId)} className="font-mono text-12-5 text-link hover:underline">
              {shortId(f.sessionId)}
            </Link>
          </Fact>
        ) : null}
      </FactsGroup>
    </>
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
  return (
    <PeekPanel peek={peek} listLabel="Automation" noun="Fire" onOpenFull={onOpenFull} testId="fire-peek">
      <PeekHead noun="Fire" itemKey={`#${shortId(f.id)}`} badge={<StatusBadge family="scheduleRun" value={f.status} />} title={f.scheduleName} />
      <FireBanner f={f} className="px-[18px]" />
      <div className="px-[18px] pb-4 pt-4">
        {schedule ? <FireFacts d={{ fire: { ...f, output: null }, schedule }} slug={slug} /> : null}
      </div>
    </PeekPanel>
  );
}

const FIRE_TABS = ["produced", "output"] as const;

function Produced({ d, slug }: { d: FireDetailResponse; slug: string }) {
  const p = d.produced;
  const empty = !p.reports.length && !p.issues.length && !p.proposals.length && !p.runs.length && !p.notifications.length;
  if (empty) return <FactsEmpty>This fire produced nothing.</FactsEmpty>;
  return (
    <div className="grid gap-8" data-testid="fire-produced-items">
      {p.reports.length ? (
        <section>
          <ViewHeading hint={`${p.reports.length}`}>Reports</ViewHeading>
          <ul className="border-t border-line-subtle">
            {p.reports.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-2 border-b border-line-subtle py-2 text-13">
                <StatusBadge family="reportTriage" value={r.triage} />
                <Link href={reportHref(slug, r.id)} className="text-link hover:underline">
                  {r.summary}
                </Link>
                <span className="text-subtle">{enumLabel("agentReportKind", r.kind)}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {p.issues.length ? (
        <section>
          <ViewHeading hint={`${p.issues.length}`}>Issues</ViewHeading>
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
          <ViewHeading hint={`${p.proposals.length}`}>Proposals</ViewHeading>
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
          <ViewHeading hint={`${p.runs.length}`}>Runs</ViewHeading>
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
          <ViewHeading hint={`${p.notifications.length}`}>Notifications</ViewHeading>
          <ul className="border-t border-line-subtle">
            {p.notifications.map((n) => (
              <li key={n.id} className="flex flex-wrap items-center gap-2 border-b border-line-subtle py-2 text-13">
                <EnumBadge family="notificationType" value={n.type} />
                <span>{n.title}</span>
                <span className="ml-auto font-mono text-11 text-subtle" title={formatStamp(n.createdAt)}>
                  {formatAge(n.createdAt)}
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
  const q = useFireDetail(projectId, fireId);
  const [tab, setTab] = useUrlTab(FIRE_TABS);
  if (q.isLoading) {
    return (
      <div className="grid min-h-[40vh] place-items-center">
        <ProjectLoader label="loading the fire…" />
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
  const tabs = [
    { value: "produced" as const, label: "Produced" },
    { value: "output" as const, label: "Output" },
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
      <DetailPane label={tab === "output" ? "Output" : "Produced"}>
        {tab === "produced" ? (
          <Produced d={d} slug={slug} />
        ) : d.fire.output ? (
          <pre className="max-h-[70vh] overflow-auto whitespace-pre-wrap break-words bg-sunken p-3 text-12-5" data-testid="fire-output">
            {d.fire.output}
          </pre>
        ) : (
          <FactsEmpty>{d.fire.sessionId ? "A prompt fire's output is its session's transcript." : "This fire wrote no output."}</FactsEmpty>
        )}
      </DetailPane>
    </DetailLayout>
  );
}

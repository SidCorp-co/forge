"use client";

// a run as core's runs read model serves it (ISS-111, design agent-run-standing rev 1): its state,
// group, holder, wait, stuck and outcome are derived in core, so the list row, the peek and the run page
// only lay those fields out
import { RUN_FINAL_STATES, type RunState } from "@forge/contracts/run-standing";
import Link from "next/link";
import {
  Button,
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
  StepBar,
  type StepView,
  Table,
  TBody,
  TD,
  TH,
  THead,
  TR,
  useUrlTab,
  ViewHeading,
  WaitBanner,
  WaitingOn,
} from "@/design";
import { QueryBoundary } from "@/lib/api/query-boundary";
import { enumLabel, type StatusFamily, statusReading } from "@/design/vocabulary";
import { issueHref } from "@/lib/routes/issues";
import { formatRefusal } from "@/lib/api/error";
import { useCopy, useInterfaceLanguage, useTimeFormat } from "@/lib/i18n/interface-language";
import { formatAge, formatDateTime } from "@/lib/i18n/format";
import type { Copy, ProductCopyKey } from "@/lib/i18n/product-copy";
import { said, saidOrNull, saidView } from "@/lib/i18n/said";
import { parkRefusalText, useCancelRun } from "@/features/run-control/hooks";
import { RUNS_STANDING_ROOT, useRunDetail } from "../hooks";
import { masterHref, runHref } from "@/lib/routes/agents";
import type { RunEvent, RunStanding, RunStandingDetail } from "../types";
import { actorName, fmtTime, leaseLeft, runBanner, runKey, runName, stamp, stepLabel, waitingView } from "../view";

const isFinal = (s: RunState) => (RUN_FINAL_STATES as readonly string[]).includes(s);

function rowFacts(r: RunStanding, t: Copy, language: string): string[] {
  const parts = [enumLabel("runLane", r.lane, language)];
  const step = stepLabel(r, language);
  if (step && r.outcome === null) parts.push(step);
  if (r.attempt.source === "runs") parts.push(t("runs.attemptN", { n: r.attempt.n }));
  if (r.device) parts.push(r.device.name);
  const o = r.outcome;
  if (o?.kind === "failed") parts.push(enumLabel("failureCause", o.cause, language));
  if (o?.kind === "handed_back" && o.close) parts.push(t("runs.closedHow", { how: enumLabel("runHandbackClose", o.close, language).toLowerCase() }));
  const by = o?.kind === "cancelled" ? actorName(o.by, language) : null;
  if (by) parts.push(t("runs.byWhoCap", { who: by }));
  return parts;
}

export const runRow =
  (hrefOf: (id: string) => string, t: Copy, language: string) =>
  (r: RunStanding): ListRowView => {
    const w = waitingView(r, language);
    const at = r.finishedAt ?? r.since ?? r.startedAt;
    return {
      key: r.id,
      keyLabel: runKey(r, language),
      href: hrefOf(r.id),
      title: said(r.says.title, language),
      facts: rowFacts(r, t, language),
      state: <StatusBadge family="runStanding" value={r.state} />,
      waitingOn: w.kind === "none" ? <span className="text-12-5 text-subtle">—</span> : <WaitingOn w={w} />,
      owner: r.holder.source === "held" ? said(r.holder.says.name, language) : t("runs.noHolder"),
      age: { text: formatAge(at, language), title: t(r.finishedAt ? "runs.finishedAt" : "runs.sinceAt", { at: formatDateTime(at, language) }) },
      dim: isFinal(r.state),
    };
  };

export function RunBanner({ r, className }: { r: RunStanding; className?: string }) {
  const language = useInterfaceLanguage();
  const b = runBanner(r, language);
  return (
    <WaitBanner tone={b.tone} head={b.head} body={b.body} rule={b.rule} className={className} testId="run-banner">
      {b.detail ? <span className="text-12-5 text-muted">{b.detail}</span> : null}
    </WaitBanner>
  );
}

const PATH: Array<{ key: string; label: ProductCopyKey; states: readonly RunState[] }> = [
  { key: "queued", label: "runs.path.queued", states: ["queued"] },
  { key: "claimed", label: "runs.path.claimed", states: ["claimed"] },
  { key: "running", label: "runs.path.running", states: ["running"] },
  { key: "wait", label: "runs.path.wait", states: ["waiting_person", "waiting_gate", "stuck"] },
  { key: "end", label: "runs.path.end", states: RUN_FINAL_STATES },
];

/** Where the run's state sits on its path: a presentation of the served state, nothing derived. */
export function RunPath({ r }: { r: RunStanding }) {
  const t = useCopy();
  const language = useInterfaceLanguage();
  const at = PATH.findIndex((p) => p.states.includes(r.state));
  const tone = r.state === "stuck" || r.state === "failed" ? "err" : r.state === "waiting_person" ? "you" : r.state === "waiting_gate" ? "blocked" : isFinal(r.state) ? "done" : "run";
  const steps: StepView[] = PATH.map((p, i) => ({
    key: p.key,
    label: t(p.label),
    state: i < at ? "done" : i === at ? "now" : "next",
    tone,
  }));
  return <StepBar steps={steps} caption={statusReading("runStanding", r.state, language).label} />;
}

function HolderFacts({ r, slug }: { r: RunStanding; slug: string }) {
  const t = useCopy();
  const language = useInterfaceLanguage();
  const time = useTimeFormat();
  const h = r.holder;
  const d = h.source === "held" ? h.dispatchedBy : null;
  return (
    <>
      <FactsGroup title={t("runs.fact.holder")}>
        {h.source === "held" ? (
          <>
            <Fact label={t("runs.fact.run")}>
              <span title={t("runs.holderKind", { kind: t(`runs.holder.${h.kind}`) })}>{said(h.says.name, language)}</span>
            </Fact>
            <Fact label={t("runs.fact.box")}>
              <span className="font-mono text-12-5">{h.device?.name ?? "—"}</span>
            </Fact>
            <Fact label={t("runs.fact.lease")}>
              <span title={saidOrNull(h.says.expiryDetail, language) ?? (h.expiresAt ? time.dateTime(h.expiresAt) : undefined)}>{leaseLeft(r, language) ?? saidOrNull(h.says.expiryDetail, language) ?? "—"}</span>
            </Fact>
          </>
        ) : (
          <FactsEmpty>{said(h.says.detail, language)}</FactsEmpty>
        )}
      </FactsGroup>
      <FactsGroup title={t("runs.fact.dispatchedBy")}>
        {d && d.source !== "none" ? (
          <>
            <Fact label={t("runs.fact.master")}>
              <Link href={masterHref(slug)} className="text-link hover:underline">
                {r.master.source === "session" ? (r.master.name ?? t("runs.fact.masterWord")) : t("runs.fact.masterWord")}
              </Link>
            </Fact>
            <Fact label={t("runs.fact.pass")}>
              {d.source === "pass" ? (
                <span title={time.dateTime(d.startedAt)}>
                  {t("runs.fact.passOf", { when: fmtTime(d.startedAt, language), verb: enumLabel("masterVerb", d.verb, language).toLowerCase() })}
                </span>
              ) : (
                <span className="text-muted" title={said(d.says.detail, language)}>
                  {t("runs.notKnown")}
                </span>
              )}
            </Fact>
          </>
        ) : (
          <FactsEmpty>{d && d.source === "none" ? said(d.says.detail, language) : r.master.source === "none" ? said(r.master.says.detail, language) : t("runs.fact.noPass")}</FactsEmpty>
        )}
      </FactsGroup>
    </>
  );
}

export function RunFacts({ r, slug }: { r: RunStanding; slug: string }) {
  const t = useCopy();
  const language = useInterfaceLanguage();
  const time = useTimeFormat();
  return (
    <>
      <FactsGroup title={t("runs.fact.standing")}>
        <Fact label={t("runs.fact.state")}>
          <StatusBadge family="runStanding" value={r.state} />
        </Fact>
        <Fact label={t("runs.fact.since")}>
          <span title={`${stamp(r.since, language)} — ${said(r.says.rule, language)}`}>{fmtTime(r.since, language)}</span>
        </Fact>
        {r.stuck.source === "stuck" ? (
          <Fact label={t("runs.fact.stuck")}>
            <span title={said(r.stuck.says.detail, language)}>{enumLabel("runStuckRule", r.stuck.rule, language)}</span>
          </Fact>
        ) : null}
      </FactsGroup>
      <HolderFacts r={r} slug={slug} />
      <FactsGroup title={t("runs.fact.work")}>
        <Fact label={t("runs.fact.subject")}>
          {r.issue ? (
            <>
              <Link href={issueHref(slug, r.issue.key)} className="font-mono text-12-5 font-semibold text-link hover:underline">
                {r.issue.key}
              </Link>
              <StatusBadge family="issue" value={r.issue.status} />
            </>
          ) : (
            <span>{runKey(r, language)}</span>
          )}
        </Fact>
        <Fact label={t("runs.fact.lane")}>
          <EnumBadge family="runLane" value={r.lane} />
        </Fact>
        <Fact label={t("runs.fact.step")}>
          <span title={r.step.source === "none" ? said(r.step.says.detail, language) : t("runs.readFrom", { source: r.step.source })}>{stepLabel(r, language) ?? "—"}</span>
        </Fact>
        {r.attempt.source === "runs" ? <Fact label={t("runs.fact.attempt")}>{r.attempt.n}</Fact> : null}
      </FactsGroup>
      <FactsGroup title={t("runs.fact.properties")}>
        <Fact label={t("runs.fact.jobType")}>{r.job ? enumLabel("jobType", r.job.type, language) : "—"}</Fact>
        {r.job ? (
          <Fact label={t("runs.fact.job")}>
            <StatusBadge family="job" value={r.job.status} />
          </Fact>
        ) : null}
        <Fact label={t("runs.fact.pipeline")}>
          <StatusBadge family="pipelineRun" value={r.pipelineStatus} />
        </Fact>
        <Fact label={t("runs.fact.started")}>
          <span title={time.dateTime(r.startedAt)}>{fmtTime(r.startedAt, language)}</span>
        </Fact>
        {r.finishedAt ? (
          <Fact label={t("runs.fact.finished")}>
            <span title={time.dateTime(r.finishedAt)}>{fmtTime(r.finishedAt, language)}</span>
          </Fact>
        ) : null}
        {r.sessionId ? (
          <Fact label={t("runs.fact.session")}>
            <span className="font-mono text-12-5" title={r.sessionId}>
              {r.sessionId.slice(0, 8)}
            </span>
          </Fact>
        ) : null}
      </FactsGroup>
    </>
  );
}

const RUNS_READS = [[RUNS_STANDING_ROOT]] as const;

/** The one primary act a run offers, and cancel beside it for a writer while it is live. */
export function RunActions({ r, slug, canWrite }: { r: RunStanding; slug: string; canWrite: boolean }) {
  const t = useCopy();
  const language = useInterfaceLanguage();
  const cancel = useCancelRun(RUNS_READS);
  const parkRefused = parkRefusalText(cancel.data);
  const live = r.outcome === null;
  const w = r.waitingOn;
  const answer = w.kind === "you" ? saidView(w, language).act : null;
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      {answer && r.issue ? (
        <Link href={issueHref(slug, r.issue.key)} className="inline-flex">
          <Button type="button" variant="primary" size="sm" data-testid="run-answer">
            {`${answer.charAt(0).toUpperCase()}${answer.slice(1)}`}
          </Button>
        </Link>
      ) : null}
      {live && canWrite ? (
        <Button type="button" size="sm" disabled={cancel.isPending} onClick={() => cancel.mutate(r.id)} data-testid="run-cancel">
          {t("runs.cancelRun")}
        </Button>
      ) : null}
      {cancel.isError ? (
        <span className="text-12-5 text-danger" data-testid="run-cancel-refusal">
          {formatRefusal(cancel.error)}
        </span>
      ) : null}
      {parkRefused ? (
        <span className="text-12-5 text-danger" data-testid="run-cancel-park-refused">
          {t("runs.parkRefused", { why: parkRefused })}
        </span>
      ) : null}
    </span>
  );
}

export function RunPeek({
  r,
  slug,
  canWrite,
  peek,
  onOpenFull,
}: {
  r: RunStanding;
  slug: string;
  canWrite: boolean;
  peek: PeekState;
  onOpenFull: () => void;
}) {
  const t = useCopy();
  const language = useInterfaceLanguage();
  return (
    <PeekPanel peek={peek} listLabel={t("agents.title")} noun={t("runs.noun")} onOpenFull={onOpenFull} testId="run-peek">
      <PeekHead
        noun={t("runs.noun")}
        itemKey={runKey(r, language)}
        badge={<StatusBadge family="runStanding" value={r.state} />}
        title={said(r.says.title, language)}
        action={<RunActions r={r} slug={slug} canWrite={canWrite} />}
      />
      <div className="px-[18px] pb-3">
        <RunPath r={r} />
      </div>
      <RunBanner r={r} className="px-[18px]" />
      <div className="px-[18px] pb-4 pt-4">
        <RunFacts r={r} slug={slug} />
      </div>
    </PeekPanel>
  );
}

export const RUN_TABS = ["overview", "attempts", "events", "lease"] as const;

function Overview({ r }: { r: RunStanding }) {
  const t = useCopy();
  const language = useInterfaceLanguage();
  const walked: Array<[string, string | null, string]> = [[t("runs.fact.started"), r.startedAt, "pipeline_runs.started_at"]];
  if (r.holder.source === "held" && r.holder.acquiredAt) walked.push([t("runs.moment.claimed"), r.holder.acquiredAt, "holder.acquiredAt"]);
  walked.push([statusReading("runStanding", r.state, language).label, r.since, `since: ${said(r.says.rule, language)}`]);
  if (r.finishedAt) walked.push([t("runs.fact.finished"), r.finishedAt, "pipeline_runs.finished_at"]);
  const stuck = r.stuck.source === "stuck" ? r.stuck : null;
  const o = r.outcome;
  return (
    <div className="grid gap-8">
      <section>
        <ViewHeading>{t("runs.fact.standing")}</ViewHeading>
        <div className="mb-4 max-w-md">
          <RunPath r={r} />
        </div>
        <Table aria-label={t("runs.fact.standing")}>
          <THead className="bg-sunken">
            <TR>
              <TH>{t("runs.moment.moment")}</TH>
              <TH>{t("runs.moment.at")}</TH>
            </TR>
          </THead>
          <TBody>
            {walked.map(([label, at, src]) => (
              <TR key={label}>
                <TD>{label}</TD>
                <TD>
                  <span title={`${stamp(at, language)} — ${src}`} translate="no">
                    {fmtTime(at, language)}
                  </span>
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      </section>
      {stuck ? (
        <section>
          <ViewHeading hint={enumLabel("runStuckRule", stuck.rule, language)}>{t("runs.whyStuck")}</ViewHeading>
          <p className="text-13">{said(stuck.says.detail, language)}</p>
          <p className="mt-1 text-12-5 text-muted">{said(stuck.says.failsBy, language)}</p>
          <p className="mt-2 font-mono text-12 text-subtle" title={stuck.evidence.value ?? undefined} translate="no">
            {stuck.evidence.table}.{stuck.evidence.column} · {stuck.evidence.id.slice(0, 8)}
            {stuck.evidence.at ? ` · ${fmtTime(stuck.evidence.at, language)}` : ""}
          </p>
        </section>
      ) : null}
      {o?.kind === "handed_back" && o.returnedTo.length > 0 ? (
        <section>
          <ViewHeading>{t("runs.returned")}</ViewHeading>
          <ul className="border-t border-line-subtle">
            {o.returnedTo.map((x) => (
              <li key={x.issueKey} className="flex items-center gap-2 border-b border-line-subtle py-2 text-13">
                <span className="font-mono text-12-5 font-semibold">{x.issueKey}</span>
                <StatusBadge family="issue" value={x.status} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

function Attempts({ d, slug }: { d: RunStandingDetail; slug: string }) {
  const t = useCopy();
  const language = useInterfaceLanguage();
  const r = d.run;
  if (d.attempts.length === 0) return <FactsEmpty>{r.attempt.source === "none" ? said(r.attempt.says.detail, language) : t("runs.oneAttempt")}</FactsEmpty>;
  return (
    <section>
      <ViewHeading>{t("runs.attemptsOn", { subject: r.attempt.source === "runs" ? r.attempt.of : t("runs.thisSubject") })}</ViewHeading>
      <Table aria-label={t("runs.attempts")}>
        <THead className="bg-sunken">
          <TR>
            <TH>{t("runs.fact.attempt")}</TH>
            <TH>{t("runs.fact.standing")}</TH>
            <TH>{t("runs.fact.started")}</TH>
            <TH>{t("runs.fact.finished")}</TH>
          </TR>
        </THead>
        <TBody>
          {d.attempts.map((a) => (
            <TR key={a.id}>
              <TD>
                {a.id === r.id ? (
                  <span className="font-mono text-12-5 font-semibold">#{a.n}</span>
                ) : (
                  <Link href={runHref(slug, a.id)} className="font-mono text-12-5 font-semibold text-link hover:underline">
                    #{a.n}
                  </Link>
                )}
              </TD>
              <TD>
                <StatusBadge family="runStanding" value={a.state} />
              </TD>
              <TD>
                <span title={formatDateTime(a.startedAt, language)}>{fmtTime(a.startedAt, language)}</span>
              </TD>
              <TD>{fmtTime(a.finishedAt, language)}</TD>
            </TR>
          ))}
        </TBody>
      </Table>
    </section>
  );
}

const EVENT_FAMILY: Record<RunEvent["entity"], StatusFamily> = { run: "pipelineRun", session: "session", job: "job" };

function Events({ d }: { d: RunStandingDetail }) {
  const t = useCopy();
  const language = useInterfaceLanguage();
  const time = useTimeFormat();
  if (d.events.length === 0) return <FactsEmpty>{t("runs.noEvents")}</FactsEmpty>;
  return (
    <section>
      <ViewHeading hint={d.eventsHasMore ? t("runs.firstN", { n: time.number(d.events.length) }) : time.number(d.events.length)}>{t("runs.transitions")}</ViewHeading>
      <Table aria-label={t("runs.transitions")}>
        <THead className="bg-sunken">
          <TR>
            <TH>{t("runs.event.when")}</TH>
            <TH>{t("runs.event.event")}</TH>
            <TH>{t("runs.event.actor")}</TH>
            <TH>{t("runs.event.reason")}</TH>
          </TR>
        </THead>
        <TBody>
          {d.events.map((e) => (
            <TR key={e.id}>
              <TD>
                <span title={formatDateTime(e.at, language)}>{fmtTime(e.at, language)}</span>
              </TD>
              <TD>
                <span className="inline-flex flex-wrap items-center gap-1.5" title={`${enumLabel("runEventEntity", e.entity, language)}: ${e.from ? statusReading(EVENT_FAMILY[e.entity], e.from, language).label : "∅"} → ${statusReading(EVENT_FAMILY[e.entity], e.to, language).label} (${e.source})`}>
                  <span className="text-muted">{enumLabel("runEventEntity", e.entity, language)}</span>
                  <StatusBadge family={EVENT_FAMILY[e.entity]} value={e.to} />
                </span>
              </TD>
              <TD>{e.actor.name ?? enumLabel("runActorType", e.actor.type, language)}</TD>
              <TD>
                <span className="text-12-5 text-muted">{e.reason ? (/^[a-z_]+$/.test(e.reason) ? enumLabel("failureCause", e.reason, language) : e.reason) : "—"}</span>
              </TD>
            </TR>
          ))}
        </TBody>
      </Table>
    </section>
  );
}

function Lease({ r }: { r: RunStanding }) {
  const t = useCopy();
  const language = useInterfaceLanguage();
  const h = r.holder;
  if (h.source !== "held") return <FactsEmpty>{said(h.says.detail, language)}</FactsEmpty>;
  return (
    <div className="grid gap-8">
      <section>
        <ViewHeading>{t("runs.fact.lease")}</ViewHeading>
        <Table aria-label={t("runs.fact.lease")}>
          <THead className="bg-sunken">
            <TR>
              <TH>{t("runs.lease.fact")}</TH>
              <TH>{t("runs.lease.value")}</TH>
            </TR>
          </THead>
          <TBody>
            <TR>
              <TD>{t("runs.fact.holder")}</TD>
              <TD>
                {said(h.says.name, language)} <span className="text-muted">({t(`runs.holder.${h.kind}`)})</span>
              </TD>
            </TR>
            <TR>
              <TD>{t("runs.lease.acquired")}</TD>
              <TD>
                <span title={stamp(h.acquiredAt, language)}>{fmtTime(h.acquiredAt, language)}</span>
              </TD>
            </TR>
            <TR>
              <TD>{t("runs.lease.expires")}</TD>
              <TD>
                <span title={saidOrNull(h.says.expiryDetail, language) ?? stamp(h.expiresAt, language)}>{h.expiresAt ? `${fmtTime(h.expiresAt, language)} · ${leaseLeft(r, language)}` : (saidOrNull(h.says.expiryDetail, language) ?? "—")}</span>
              </TD>
            </TR>
            <TR>
              <TD>{t("runs.lease.source")}</TD>
              <TD>{h.expirySource ? <EnumBadge family="runExpirySource" value={h.expirySource} /> : "—"}</TD>
            </TR>
            <TR>
              <TD>{t("runs.lease.verdict")}</TD>
              <TD>{h.verdict ? <StatusBadge family="lease" value={h.verdict} /> : "—"}</TD>
            </TR>
          </TBody>
        </Table>
      </section>
      {h.expiries.length > 1 ? (
        <section>
          <ViewHeading hint={t("runs.lease.earliest")}>{t("runs.lease.everyClock")}</ViewHeading>
          <ul className="border-t border-line-subtle">
            {h.expiries.map((x) => (
              <li key={`${x.source}:${x.at}`} className="flex flex-wrap items-center gap-2 border-b border-line-subtle py-2 text-13">
                <EnumBadge family="runExpirySource" value={x.source} />
                <span title={formatDateTime(x.at, language)}>{fmtTime(x.at, language)}</span>
                <StatusBadge family="lease" value={x.verdict} />
                <span className="text-12-5 text-muted">{said(x.says.rule, language)}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : (
        <p className="text-12-5 text-subtle" title={saidOrNull(h.expiries[0]?.says.rule, language) ?? undefined}>
          {saidOrNull(h.expiries[0]?.says.rule, language) ?? saidOrNull(h.says.expiryDetail, language)}
        </p>
      )}
    </div>
  );
}

export function RunPage({ projectId, slug, runId }: { projectId: string; slug: string; runId: string }) {
  const t = useCopy();
  const language = useInterfaceLanguage();
  const q = useRunDetail(projectId, runId);
  const [tab, setTab] = useUrlTab(RUN_TABS);
  return (
    <QueryBoundary query={q} loadingLabel={t("runs.loadingRun")}>
      {(data) => {
        const d = data;
        const r = d.run;
        const tabs = [
          { value: "overview" as const, label: t("runs.tab.overview") },
          { value: "attempts" as const, label: t("runs.tab.attempts"), count: Math.max(d.attempts.length, 1) },
          { value: "events" as const, label: t("runs.tab.events"), count: d.events.length },
          { value: "lease" as const, label: t("runs.tab.lease") },
        ];
        return (
          <DetailLayout
            testId="run-detail"
            dataKey={r.id}
            rail={
              <FactsRail>
                <RunFacts r={r} slug={slug} />
              </FactsRail>
            }
          >
            <DetailMobileTitle itemKey={runKey(r, language)} title={runName(r, language)} badge={<StatusBadge family="runStanding" value={r.state} />} />
            <RunBanner r={r} className="px-8 py-2.5 max-md:px-4" />
            <DetailTabs tabs={tabs} value={tab} onChange={setTab} testId="run-tabs" />
            <DetailPane label={tabs.find((x) => x.value === tab)?.label ?? t("runs.tab.overview")}>
              {tab === "overview" ? <Overview r={r} /> : null}
              {tab === "attempts" ? <Attempts d={d} slug={slug} /> : null}
              {tab === "events" ? <Events d={d} /> : null}
              {tab === "lease" ? <Lease r={r} /> : null}
            </DetailPane>
          </DetailLayout>
        );
      }}
    </QueryBoundary>
  );
}

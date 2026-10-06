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
import { enumLabel, type StatusFamily, statusReading } from "@/design/vocabulary";
import { issueHref } from "@/lib/routes/issues";
import { formatApiError, formatRefusal, isRetryableApiError } from "@/lib/api/error";
import { formatAge, formatStamp } from "@/lib/utils/format";
import { useCancelRun, useRunDetail } from "../hooks";
import { masterHref, runHref } from "@/lib/routes/agents";
import type { RunEvent, RunStanding, RunStandingDetail } from "../types";
import { actorName, fmtTime, leaseLeft, runBanner, runKey, runName, stamp, stepLabel, waitingView } from "../view";

const isFinal = (s: RunState) => (RUN_FINAL_STATES as readonly string[]).includes(s);

function rowFacts(r: RunStanding): string[] {
  const parts = [enumLabel("runLane", r.lane)];
  const step = stepLabel(r);
  if (step && r.outcome === null) parts.push(step);
  if (r.attempt.source === "runs") parts.push(`Attempt ${r.attempt.n}`);
  if (r.device) parts.push(r.device.name);
  const o = r.outcome;
  if (o?.kind === "failed") parts.push(enumLabel("failureCause", o.cause));
  if (o?.kind === "handed_back" && o.close) parts.push(`Closed ${enumLabel("runHandbackClose", o.close).toLowerCase()}`);
  const by = o?.kind === "cancelled" ? actorName(o.by) : null;
  if (by) parts.push(`By ${by}`);
  return parts;
}

export const runRow =
  (hrefOf: (id: string) => string) =>
  (r: RunStanding): ListRowView => {
    const w = waitingView(r);
    const at = r.finishedAt ?? r.since ?? r.startedAt;
    return {
      key: r.id,
      keyLabel: runKey(r),
      href: hrefOf(r.id),
      title: r.title,
      facts: rowFacts(r),
      state: <StatusBadge family="runStanding" value={r.state} />,
      waitingOn: w.kind === "none" ? <span className="text-12-5 text-subtle">—</span> : <WaitingOn w={w} />,
      owner: r.holder.source === "held" ? r.holder.name : "No holder",
      age: { text: formatAge(at), title: `${r.finishedAt ? "Finished" : "Since"} ${formatStamp(at)}` },
      dim: isFinal(r.state),
    };
  };

export function RunBanner({ r, className }: { r: RunStanding; className?: string }) {
  const b = runBanner(r);
  return (
    <WaitBanner tone={b.tone} head={b.head} body={b.body} rule={b.rule} className={className} testId="run-banner">
      {b.detail ? <span className="text-12-5 text-muted">{b.detail}</span> : null}
    </WaitBanner>
  );
}

const PATH: Array<{ key: string; label: string; states: readonly RunState[] }> = [
  { key: "queued", label: "Queued", states: ["queued"] },
  { key: "claimed", label: "Claimed", states: ["claimed"] },
  { key: "running", label: "Running", states: ["running"] },
  { key: "wait", label: "Waiting or stuck", states: ["waiting_person", "waiting_gate", "stuck"] },
  { key: "end", label: "Finished", states: RUN_FINAL_STATES },
];

/** Where the run's state sits on its path: a presentation of the served state, nothing derived. */
export function RunPath({ r }: { r: RunStanding }) {
  const at = PATH.findIndex((p) => p.states.includes(r.state));
  const tone = r.state === "stuck" || r.state === "failed" ? "err" : r.state === "waiting_person" ? "you" : r.state === "waiting_gate" ? "blocked" : isFinal(r.state) ? "done" : "run";
  const steps: StepView[] = PATH.map((p, i) => ({
    key: p.key,
    label: p.label,
    state: i < at ? "done" : i === at ? "now" : "next",
    tone,
  }));
  return <StepBar steps={steps} caption={statusReading("runStanding", r.state).label} />;
}

function HolderFacts({ r, slug }: { r: RunStanding; slug: string }) {
  const h = r.holder;
  const d = h.source === "held" ? h.dispatchedBy : null;
  return (
    <>
      <FactsGroup title="Holder">
        {h.source === "held" ? (
          <>
            <Fact label="Run">
              <span title={`holder kind ${h.kind}`}>{h.name}</span>
            </Fact>
            <Fact label="Box">
              <span className="font-mono text-12-5">{h.device?.name ?? "—"}</span>
            </Fact>
            <Fact label="Lease">
              <span title={h.expiryDetail ?? (h.expiresAt ? formatStamp(h.expiresAt) : undefined)}>{leaseLeft(r) ?? h.expiryDetail ?? "—"}</span>
            </Fact>
          </>
        ) : (
          <FactsEmpty>{h.detail}</FactsEmpty>
        )}
      </FactsGroup>
      <FactsGroup title="Dispatched by">
        {d && d.source !== "none" ? (
          <>
            <Fact label="Master">
              <Link href={masterHref(slug)} className="text-link hover:underline">
                {r.master.source === "session" ? (r.master.name ?? "Master") : "Master"}
              </Link>
            </Fact>
            <Fact label="Pass">
              {d.source === "pass" ? (
                <span title={formatStamp(d.startedAt)}>
                  {fmtTime(d.startedAt)} {enumLabel("masterVerb", d.verb).toLowerCase()} pass
                </span>
              ) : (
                <span className="text-muted" title={d.detail}>
                  Not known
                </span>
              )}
            </Fact>
          </>
        ) : (
          <FactsEmpty>{d && d.source === "none" ? d.detail : r.master.source === "none" ? r.master.detail : "No holder, so no pass took it yet."}</FactsEmpty>
        )}
      </FactsGroup>
    </>
  );
}

export function RunFacts({ r, slug }: { r: RunStanding; slug: string }) {
  return (
    <>
      <FactsGroup title="Standing">
        <Fact label="State">
          <StatusBadge family="runStanding" value={r.state} />
        </Fact>
        <Fact label="Since">
          <span title={`${stamp(r.since)} — ${r.rule}`}>{fmtTime(r.since)}</span>
        </Fact>
        {r.stuck.source === "stuck" ? (
          <Fact label="Stuck">
            <span title={r.stuck.detail}>{enumLabel("runStuckRule", r.stuck.rule)}</span>
          </Fact>
        ) : null}
      </FactsGroup>
      <HolderFacts r={r} slug={slug} />
      <FactsGroup title="Work">
        <Fact label="Subject">
          {r.issue ? (
            <>
              <Link href={issueHref(slug, r.issue.key)} className="font-mono text-12-5 font-semibold text-link hover:underline">
                {r.issue.key}
              </Link>
              <StatusBadge family="issue" value={r.issue.status} />
            </>
          ) : (
            <span>{runKey(r)}</span>
          )}
        </Fact>
        <Fact label="Lane">
          <EnumBadge family="runLane" value={r.lane} />
        </Fact>
        <Fact label="Step">
          <span title={r.step.source === "none" ? r.step.detail : `read from ${r.step.source}`}>{stepLabel(r) ?? "—"}</span>
        </Fact>
        {r.attempt.source === "runs" ? <Fact label="Attempt">{r.attempt.n}</Fact> : null}
      </FactsGroup>
      <FactsGroup title="Properties">
        <Fact label="Job type">{r.job ? enumLabel("jobType", r.job.type) : "—"}</Fact>
        {r.job ? (
          <Fact label="Job">
            <StatusBadge family="job" value={r.job.status} />
          </Fact>
        ) : null}
        <Fact label="Pipeline">
          <StatusBadge family="pipelineRun" value={r.pipelineStatus} />
        </Fact>
        <Fact label="Started">
          <span title={formatStamp(r.startedAt)}>{fmtTime(r.startedAt)}</span>
        </Fact>
        {r.finishedAt ? (
          <Fact label="Finished">
            <span title={formatStamp(r.finishedAt)}>{fmtTime(r.finishedAt)}</span>
          </Fact>
        ) : null}
        {r.sessionId ? (
          <Fact label="Session">
            <span className="font-mono text-12-5" title={r.sessionId}>
              {r.sessionId.slice(0, 8)}
            </span>
          </Fact>
        ) : null}
      </FactsGroup>
    </>
  );
}

/** The one primary act a run offers, and cancel beside it for a writer while it is live. */
export function RunActions({ r, slug, projectId, canWrite }: { r: RunStanding; slug: string; projectId: string; canWrite: boolean }) {
  const cancel = useCancelRun(projectId);
  const live = r.outcome === null;
  const w = r.waitingOn;
  const answer = w.kind === "you" ? w.act : null;
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
          Cancel run
        </Button>
      ) : null}
      {cancel.isError ? (
        <span className="text-12-5 text-danger" data-testid="run-cancel-refusal">
          {formatRefusal(cancel.error)}
        </span>
      ) : null}
    </span>
  );
}

export function RunPeek({
  r,
  slug,
  projectId,
  canWrite,
  peek,
  onOpenFull,
}: {
  r: RunStanding;
  slug: string;
  projectId: string;
  canWrite: boolean;
  peek: PeekState;
  onOpenFull: () => void;
}) {
  return (
    <PeekPanel peek={peek} listLabel="Agents / Runs" noun="Run" onOpenFull={onOpenFull} testId="run-peek">
      <PeekHead
        noun="Run"
        itemKey={runKey(r)}
        badge={<StatusBadge family="runStanding" value={r.state} />}
        title={r.title}
        action={<RunActions r={r} slug={slug} projectId={projectId} canWrite={canWrite} />}
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
  const walked: Array<[string, string | null, string]> = [["Started", r.startedAt, "pipeline_runs.started_at"]];
  if (r.holder.source === "held" && r.holder.acquiredAt) walked.push(["Claimed", r.holder.acquiredAt, "holder.acquiredAt"]);
  walked.push([statusReading("runStanding", r.state).label, r.since, `since: ${r.rule}`]);
  if (r.finishedAt) walked.push(["Finished", r.finishedAt, "pipeline_runs.finished_at"]);
  const stuck = r.stuck.source === "stuck" ? r.stuck : null;
  const o = r.outcome;
  return (
    <div className="grid gap-8">
      <section>
        <ViewHeading>Standing</ViewHeading>
        <div className="mb-4 max-w-md">
          <RunPath r={r} />
        </div>
        <Table aria-label="Standing">
          <THead className="bg-sunken">
            <TR>
              <TH>Moment</TH>
              <TH>At</TH>
            </TR>
          </THead>
          <TBody>
            {walked.map(([label, at, src]) => (
              <TR key={label}>
                <TD>{label}</TD>
                <TD>
                  <span title={`${stamp(at)} — ${src}`}>{fmtTime(at)}</span>
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      </section>
      {stuck ? (
        <section>
          <ViewHeading hint={enumLabel("runStuckRule", stuck.rule)}>Why it is stuck</ViewHeading>
          <p className="text-13">{stuck.detail}</p>
          <p className="mt-1 text-12-5 text-muted">{stuck.failsBy}</p>
          <p className="mt-2 font-mono text-12 text-subtle" title={stuck.evidence.value ?? undefined}>
            {stuck.evidence.table}.{stuck.evidence.column} · {stuck.evidence.id.slice(0, 8)}
            {stuck.evidence.at ? ` · ${fmtTime(stuck.evidence.at)}` : ""}
          </p>
        </section>
      ) : null}
      {o?.kind === "handed_back" && o.returnedTo.length > 0 ? (
        <section>
          <ViewHeading>Returned</ViewHeading>
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
  const r = d.run;
  if (d.attempts.length === 0) return <FactsEmpty>{r.attempt.source === "none" ? r.attempt.detail : "One attempt."}</FactsEmpty>;
  return (
    <section>
      <ViewHeading>Attempts on {r.attempt.source === "runs" ? r.attempt.of : "this subject"}</ViewHeading>
      <Table aria-label="Attempts">
        <THead className="bg-sunken">
          <TR>
            <TH>Attempt</TH>
            <TH>Standing</TH>
            <TH>Started</TH>
            <TH>Finished</TH>
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
                <span title={formatStamp(a.startedAt)}>{fmtTime(a.startedAt)}</span>
              </TD>
              <TD>{fmtTime(a.finishedAt)}</TD>
            </TR>
          ))}
        </TBody>
      </Table>
    </section>
  );
}

const EVENT_FAMILY: Record<RunEvent["entity"], StatusFamily> = { run: "pipelineRun", session: "session", job: "job" };

function Events({ d }: { d: RunStandingDetail }) {
  if (d.events.length === 0) return <FactsEmpty>No kernel transition is recorded for this run, its session or its job.</FactsEmpty>;
  return (
    <section>
      <ViewHeading hint={d.eventsHasMore ? `the first ${d.events.length}` : `${d.events.length}`}>Transitions</ViewHeading>
      <Table aria-label="Transitions">
        <THead className="bg-sunken">
          <TR>
            <TH>When</TH>
            <TH>Event</TH>
            <TH>Actor</TH>
            <TH>Reason</TH>
          </TR>
        </THead>
        <TBody>
          {d.events.map((e) => (
            <TR key={e.id}>
              <TD>
                <span title={formatStamp(e.at)}>{fmtTime(e.at)}</span>
              </TD>
              <TD>
                <span className="inline-flex flex-wrap items-center gap-1.5" title={`${e.entity}: ${e.from ?? "∅"} → ${e.to} (${e.source})`}>
                  <span className="text-muted">{enumLabel("runEventEntity", e.entity)}</span>
                  <StatusBadge family={EVENT_FAMILY[e.entity]} value={e.to} />
                </span>
              </TD>
              <TD>{e.actor.name ?? enumLabel("runActorType", e.actor.type)}</TD>
              <TD>
                <span className="text-12-5 text-muted">{e.reason ? (/^[a-z_]+$/.test(e.reason) ? enumLabel("failureCause", e.reason) : e.reason) : "—"}</span>
              </TD>
            </TR>
          ))}
        </TBody>
      </Table>
    </section>
  );
}

function Lease({ r }: { r: RunStanding }) {
  const h = r.holder;
  if (h.source !== "held") return <FactsEmpty>{h.detail}</FactsEmpty>;
  return (
    <div className="grid gap-8">
      <section>
        <ViewHeading>Lease</ViewHeading>
        <Table aria-label="Lease">
          <THead className="bg-sunken">
            <TR>
              <TH>Fact</TH>
              <TH>Value</TH>
            </TR>
          </THead>
          <TBody>
            <TR>
              <TD>Holder</TD>
              <TD>
                {h.name} <span className="text-muted">({h.kind})</span>
              </TD>
            </TR>
            <TR>
              <TD>Acquired</TD>
              <TD>
                <span title={stamp(h.acquiredAt)}>{fmtTime(h.acquiredAt)}</span>
              </TD>
            </TR>
            <TR>
              <TD>Expires</TD>
              <TD>
                <span title={h.expiryDetail ?? stamp(h.expiresAt)}>{h.expiresAt ? `${fmtTime(h.expiresAt)} · ${leaseLeft(r)}` : (h.expiryDetail ?? "—")}</span>
              </TD>
            </TR>
            <TR>
              <TD>Expiry source</TD>
              <TD>{h.expirySource ? <EnumBadge family="runExpirySource" value={h.expirySource} /> : "—"}</TD>
            </TR>
            <TR>
              <TD>Verdict</TD>
              <TD>{h.verdict ? <StatusBadge family="lease" value={h.verdict} /> : "—"}</TD>
            </TR>
          </TBody>
        </Table>
      </section>
      {h.expiries.length > 1 ? (
        <section>
          <ViewHeading hint="the earliest is the one served">Every clock on this lease</ViewHeading>
          <ul className="border-t border-line-subtle">
            {h.expiries.map((x) => (
              <li key={`${x.source}:${x.at}`} className="flex flex-wrap items-center gap-2 border-b border-line-subtle py-2 text-13">
                <EnumBadge family="runExpirySource" value={x.source} />
                <span title={formatStamp(x.at)}>{fmtTime(x.at)}</span>
                <StatusBadge family="lease" value={x.verdict} />
                <span className="text-12-5 text-muted">{x.rule}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : (
        <p className="text-12-5 text-subtle" title={h.expiries[0]?.rule}>
          {h.expiries[0]?.rule ?? h.expiryDetail}
        </p>
      )}
    </div>
  );
}

export function RunPage({ projectId, slug, runId }: { projectId: string; slug: string; runId: string }) {
  const q = useRunDetail(projectId, runId);
  const [tab, setTab] = useUrlTab(RUN_TABS);
  if (q.isLoading) {
    return (
      <div className="grid min-h-[40vh] place-items-center">
        <ProjectLoader label="loading the run…" />
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
  const r = d.run;
  const tabs = [
    { value: "overview" as const, label: "Overview" },
    { value: "attempts" as const, label: "Attempts", count: Math.max(d.attempts.length, 1) },
    { value: "events" as const, label: "Events", count: d.events.length },
    { value: "lease" as const, label: "Lease" },
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
      <DetailMobileTitle itemKey={runKey(r)} title={runName(r)} badge={<StatusBadge family="runStanding" value={r.state} />} />
      <RunBanner r={r} className="px-8 py-2.5 max-md:px-4" />
      <DetailTabs tabs={tabs} value={tab} onChange={setTab} testId="run-tabs" />
      <DetailPane label={tabs.find((t) => t.value === tab)?.label ?? "Overview"}>
        {tab === "overview" ? <Overview r={r} /> : null}
        {tab === "attempts" ? <Attempts d={d} slug={slug} /> : null}
        {tab === "events" ? <Events d={d} /> : null}
        {tab === "lease" ? <Lease r={r} /> : null}
      </DetailPane>
    </DetailLayout>
  );
}

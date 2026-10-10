"use client";

// a run as core's runs read model serves it (ISS-111, design agent-run-standing rev 1): its state,
// group, holder, wait, stuck and outcome are derived in core, so the list row, the peek and the run page
// only lay those fields out
import { RUN_FINAL_STATES, type RunState } from "@forge/contracts/run-standing";
import Link from "next/link";
import {
  Button,
  EnumBadge,
  Fact,
  FactsEmpty,
  FactsGroup,
  type ListRowView,
  PeekHead,
  PeekPanel,
  type PeekState,
  StatusBadge,
  StepBar,
  type StepView,
  WaitBanner,
  WaitingOn,
} from "@/design";
import { enumLabel, statusReading } from "@/design/vocabulary";
import { issueHref } from "@/lib/routes/issues";
import { formatRefusal } from "@/lib/api/error";
import { useCopy, useInterfaceLanguage, useTimeFormat } from "@/lib/i18n/interface-language";
import { formatAge, formatDateTime } from "@/lib/i18n/format";
import type { Copy, ProductCopyKey } from "@/lib/i18n/product-copy";
import { said, saidOrNull, saidView } from "@/lib/i18n/said";
import { parkRefusalText, useCancelRun } from "@/features/run-control";
import { RUNS_STANDING_ROOT } from "../hooks";
import { masterHref } from "@/lib/routes/agents";
import type { RunStanding } from "../types";
import { actorName, fmtTime, leaseLeft, runBanner, runKey, stamp, stepLabel, waitingView } from "../view";

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
      waitingOn: w.kind === "none" ? <span className="text-13 text-subtle">—</span> : <WaitingOn w={w} />,
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
      {b.detail ? <span className="text-13 text-muted">{b.detail}</span> : null}
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

function RunHolder({ r, slug }: { r: RunStanding; slug: string }) {
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
              <span className="font-mono text-13">{h.device?.name ?? "—"}</span>
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

export function RunProperties({ r, slug }: { r: RunStanding; slug: string }) {
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
      <RunHolder r={r} slug={slug} />
      <FactsGroup title={t("runs.fact.work")}>
        <Fact label={t("runs.fact.subject")}>
          {r.issue ? (
            <>
              <Link href={issueHref(slug, r.issue.key)} className="font-mono text-13 font-semibold text-link hover:underline">
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
        {r.boxRunId ? (
          <Fact label={t("runs.fact.boxRunId")}>
            <span className="break-all font-mono text-13" data-testid="run-box-id">
              {r.boxRunId}
            </span>
          </Fact>
        ) : null}
        {r.sessionId ? (
          <Fact label={t("runs.fact.session")}>
            <span className="font-mono text-13" title={r.sessionId}>
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
        <span className="text-13 text-danger" data-testid="run-cancel-refusal">
          {formatRefusal(cancel.error)}
        </span>
      ) : null}
      {parkRefused ? (
        <span className="text-13 text-danger" data-testid="run-cancel-park-refused">
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
      <div className="px-4.5 pb-3">
        <RunPath r={r} />
      </div>
      <RunBanner r={r} className="px-4.5" />
      <div className="px-4.5 pb-4 pt-4">
        <RunProperties r={r} slug={slug} />
      </div>
    </PeekPanel>
  );
}

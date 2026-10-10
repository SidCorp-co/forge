"use client";

// The run's full page: its tabs (overview, what it was given, attempts, events, lease) beside the
// properties rail, all from core's run detail read. A person's view says each fact once and reads as
// state; the developer view adds core's own sentences, codes, ids, what the run was given and the
// lease's clocks (REQ-43 BC-5, BC-7).
import Link from "next/link";
import {
  DetailLayout,
  DetailMobileTitle,
  DetailPane,
  DetailTabs,
  EnumBadge,
  FactsEmpty,
  FactsRail,
  Property,
  PropertyList,
  type RecordView,
  RecordViewSwitch,
  Section,
  StatusBadge,
  Table,
  TBody,
  TD,
  TH,
  THead,
  TR,
  useRecordView,
  useUrlTab,
} from "@/design";
import { enumLabel, type StatusFamily, statusReading } from "@/design/vocabulary";
import { QueryBoundary } from "@/lib/api/query-boundary";
import { formatDateTime, formatWhen } from "@/lib/i18n/format";
import { useCopy, useInterfaceLanguage } from "@/lib/i18n/interface-language";
import { said, saidOrNull } from "@/lib/i18n/said";
import { runHref } from "@/lib/routes/agents";
import { useRunDetail } from "../hooks";
import type { RunEvent, RunStanding, RunStandingDetail } from "../types";
import { leaseLeft, runKey, runName } from "../view";
import { RunGivenView } from "./run-given";
import { RunBanner, RunPath, RunProperties } from "./run-views";

export const RUN_TABS = ["overview", "given", "attempts", "events", "lease"] as const;

function Overview({ r, developer }: { r: RunStanding; developer: boolean }) {
  const t = useCopy();
  const language = useInterfaceLanguage();
  const walked: Array<[string, string | null, string]> = [[t("runs.fact.started"), r.startedAt, "pipeline_runs.started_at"]];
  if (r.holder.source === "held" && r.holder.acquiredAt) walked.push([t("runs.moment.claimed"), r.holder.acquiredAt, "holder.acquiredAt"]);
  walked.push([t("runs.fact.since"), r.since, `since: ${said(r.says.rule, language)}`]);
  if (r.finishedAt) walked.push([t("runs.fact.finished"), r.finishedAt, "pipeline_runs.finished_at"]);
  const stuck = developer && r.stuck.source === "stuck" ? r.stuck : null;
  const o = developer ? r.outcome : null;
  return (
    <div>
      <Section title={t("runs.fact.standing")}>
        <div className="mb-4 max-w-md">
          <RunPath r={r} />
        </div>
        <PropertyList>
          {walked.map(([label, at, src]) => (
            <Property key={label} label={label}>
              <span title={developer ? `${formatWhen(at, language)} — ${src}` : formatWhen(at, language)} translate="no">
                {formatWhen(at, language)}
              </span>
            </Property>
          ))}
        </PropertyList>
      </Section>
      {stuck ? (
        <Section title={t("runs.whyStuck")} right={<span className="text-13 text-muted">{enumLabel("runStuckRule", stuck.rule, language)}</span>}>
          <p className="text-13">{said(stuck.says.detail, language)}</p>
          <p className="mt-1 text-13 text-muted">{said(stuck.says.failsBy, language)}</p>
          <p className="mt-2 font-mono text-12 text-subtle" title={stuck.evidence.value ?? undefined} translate="no">
            {stuck.evidence.table}.{stuck.evidence.column} · {stuck.evidence.id.slice(0, 8)}
            {stuck.evidence.at ? ` · ${formatWhen(stuck.evidence.at, language)}` : ""}
          </p>
        </Section>
      ) : null}
      {o?.kind === "handed_back" && o.returnedTo.length > 0 ? (
        <Section title={t("runs.returned")}>
          <ul className="border-t border-line-subtle">
            {o.returnedTo.map((x) => (
              <li key={x.issueKey} className="flex items-center gap-2 border-b border-line-subtle py-2 text-13">
                <span className="font-mono text-13 font-semibold">{x.issueKey}</span>
                <StatusBadge family="issue" value={x.status} />
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
    </div>
  );
}

function Attempts({ d, slug, developer }: { d: RunStandingDetail; slug: string; developer: boolean }) {
  const t = useCopy();
  const language = useInterfaceLanguage();
  const r = d.run;
  if (d.attempts.length === 0) return <FactsEmpty>{r.attempt.source === "none" ? said(r.attempt.says.detail, language) : t("runs.oneAttempt")}</FactsEmpty>;
  return (
    <Section title={developer ? t("runs.attemptsOn", { subject: r.attempt.source === "runs" ? r.attempt.of : t("runs.thisSubject") }) : t("runs.attempts")}>
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
                  <span className="font-mono text-13 font-semibold">#{a.n}</span>
                ) : (
                  <Link href={runHref(slug, a.id)} className="font-mono text-13 font-semibold text-link hover:underline">
                    #{a.n}
                  </Link>
                )}
              </TD>
              <TD>
                <StatusBadge family="runStanding" value={a.state} />
              </TD>
              <TD>
                <span title={formatDateTime(a.startedAt, language)}>{formatWhen(a.startedAt, language)}</span>
              </TD>
              <TD>{formatWhen(a.finishedAt, language)}</TD>
            </TR>
          ))}
        </TBody>
      </Table>
    </Section>
  );
}

const EVENT_FAMILY: Record<RunEvent["entity"], StatusFamily> = { run: "pipelineRun", session: "session", job: "job" };

function Events({ d, developer }: { d: RunStandingDetail; developer: boolean }) {
  const t = useCopy();
  const language = useInterfaceLanguage();
  if (d.events.length === 0) return <FactsEmpty>{t("runs.noEvents")}</FactsEmpty>;
  return (
    <Section title={t("runs.transitions")} right={d.eventsHasMore ? <span className="text-13 text-muted">{t("runs.moreNotShown")}</span> : null}>
      <Table aria-label={t("runs.transitions")}>
        <THead className="bg-sunken">
          <TR>
            <TH>{t("runs.event.when")}</TH>
            <TH>{t("runs.event.event")}</TH>
            <TH>{t("runs.event.actor")}</TH>
            {developer ? <TH>{t("runs.event.reason")}</TH> : null}
          </TR>
        </THead>
        <TBody>
          {d.events.map((e) => (
            <TR key={e.id}>
              <TD>
                <span title={formatDateTime(e.at, language)}>{formatWhen(e.at, language)}</span>
              </TD>
              <TD>
                <span className="inline-flex flex-wrap items-center gap-1.5" title={developer ? `${enumLabel("runEventEntity", e.entity, language)}: ${e.from ? statusReading(EVENT_FAMILY[e.entity], e.from, language).label : "∅"} → ${statusReading(EVENT_FAMILY[e.entity], e.to, language).label} (${e.source})` : undefined}>
                  <span className="text-muted">{enumLabel("runEventEntity", e.entity, language)}</span>
                  <StatusBadge family={EVENT_FAMILY[e.entity]} value={e.to} />
                </span>
              </TD>
              <TD>{e.actor.name ?? enumLabel("runActorType", e.actor.type, language)}</TD>
              {developer ? (
                <TD>
                  <span className="text-13 text-muted">{e.reason ? (/^[a-z_]+$/.test(e.reason) ? enumLabel("failureCause", e.reason, language) : e.reason) : "—"}</span>
                </TD>
              ) : null}
            </TR>
          ))}
        </TBody>
      </Table>
    </Section>
  );
}

function Lease({ r }: { r: RunStanding }) {
  const t = useCopy();
  const language = useInterfaceLanguage();
  const h = r.holder;
  if (h.source !== "held") return <FactsEmpty>{said(h.says.detail, language)}</FactsEmpty>;
  return (
    <div>
      <Section title={t("runs.fact.lease")}>
        <PropertyList>
          <Property label={t("runs.fact.holder")}>{said(h.says.name, language)} <span className="text-muted">({t(`runs.holder.${h.kind}`)})</span></Property>
          <Property label={t("runs.lease.acquired")}><span title={formatWhen(h.acquiredAt, language)}>{formatWhen(h.acquiredAt, language)}</span></Property>
          <Property label={t("runs.lease.expires")}><span title={saidOrNull(h.says.expiryDetail, language) ?? formatWhen(h.expiresAt, language)}>{h.expiresAt ? `${formatWhen(h.expiresAt, language)} · ${leaseLeft(r, language)}` : (saidOrNull(h.says.expiryDetail, language) ?? "—")}</span></Property>
          <Property label={t("runs.lease.source")}>{h.expirySource ? <EnumBadge family="runExpirySource" value={h.expirySource} /> : "—"}</Property>
          <Property label={t("runs.lease.verdict")}>{h.verdict ? <StatusBadge family="lease" value={h.verdict} /> : "—"}</Property>
        </PropertyList>
      </Section>
      {h.expiries.length > 1 ? (
        <Section title={t("runs.lease.everyClock")}>
          <ul className="border-t border-line-subtle">
            {h.expiries.map((x) => (
              <li key={`${x.source}:${x.at}`} className="flex flex-wrap items-center gap-2 border-b border-line-subtle py-2 text-13">
                <EnumBadge family="runExpirySource" value={x.source} />
                <span title={formatDateTime(x.at, language)}>{formatWhen(x.at, language)}</span>
                <StatusBadge family="lease" value={x.verdict} />
                <span className="text-13 text-muted">{said(x.says.rule, language)}</span>
              </li>
            ))}
          </ul>
        </Section>
      ) : (
        <p className="text-13 text-subtle" title={saidOrNull(h.expiries[0]?.says.rule, language) ?? undefined}>
          {saidOrNull(h.expiries[0]?.says.rule, language) ?? saidOrNull(h.says.expiryDetail, language)}
        </p>
      )}
    </div>
  );
}

/** The person / developer switch, at the right above the tabs. */
function ViewBar({ view, onView }: { view: RecordView; onView: (v: RecordView) => void }) {
  return (
    <div className="flex justify-end px-8 pt-3 max-md:px-4" data-testid="run-view-bar">
      <RecordViewSwitch view={view} onView={onView} />
    </div>
  );
}

/** The developer view's tabs: what the run was given and its lease are agent text (REQ-43 BC-7). */
const DEVELOPER_TABS: ReadonlySet<string> = new Set(["given", "lease"]);

export function RunPage({ projectId, slug, runId }: { projectId: string; slug: string; runId: string }) {
  const t = useCopy();
  const language = useInterfaceLanguage();
  const q = useRunDetail(projectId, runId);
  const [picked, setTab] = useUrlTab(RUN_TABS);
  const [view, onView] = useRecordView();
  const developer = view === "developer";
  const tab = DEVELOPER_TABS.has(picked) && !developer ? "overview" : picked;
  return (
    <QueryBoundary query={q} loadingLabel={t("runs.loadingRun")}>
      {(data) => {
        const d = data;
        const r = d.run;
        const tabs = [
          { value: "overview" as const, label: t("runs.tab.overview") },
          ...(developer ? [{ value: "given" as const, label: t("runs.tab.given") }] : []),
          { value: "attempts" as const, label: t("runs.tab.attempts"), count: Math.max(d.attempts.length, 1) },
          { value: "events" as const, label: t("runs.tab.events"), count: d.events.length },
          ...(developer ? [{ value: "lease" as const, label: t("runs.tab.lease") }] : []),
        ];
        return (
          <DetailLayout
            testId="run-detail"
            dataKey={r.id}
            rail={
              <FactsRail>
                <RunProperties r={r} slug={slug} developer={developer} onPage />
              </FactsRail>
            }
          >
            <DetailMobileTitle itemKey={runKey(r, language)} title={runName(r, language)} badge={<StatusBadge family="runStanding" value={r.state} />} />
            <RunBanner r={r} developer={developer} className="px-8 py-2.5 max-md:px-4" />
            <ViewBar view={view} onView={onView} />
            <DetailTabs tabs={tabs} value={tab} onChange={setTab} testId="run-tabs" />
            <DetailPane label={tabs.find((x) => x.value === tab)?.label ?? t("runs.tab.overview")}>
              {tab === "overview" ? <Overview r={r} developer={developer} /> : null}
              {tab === "given" ? <RunGivenView given={d.given ?? null} slug={slug} /> : null}
              {tab === "attempts" ? <Attempts d={d} slug={slug} developer={developer} /> : null}
              {tab === "events" ? <Events d={d} developer={developer} /> : null}
              {tab === "lease" ? <Lease r={r} /> : null}
            </DetailPane>
          </DetailLayout>
        );
      }}
    </QueryBoundary>
  );
}

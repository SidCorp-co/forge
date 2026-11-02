
// the project master as masters/standing serves it (ISS-111, design agent-run-standing rev 1, region
// master): its state, open pass, last pass and slots are core's; the list row, the peek and the master page
// lay them out, and its passes come from masters/passes
import { Link } from "@/lib/navigation/router";
import {
  DetailDrawer,
  DetailMobileTitle,
  DetailPane,
  DetailTabs,
  ErrorState,
  Fact,
  FactsEmpty,
  FactsGroup,
  FactsRail,
  MarkStrip,
  ProjectLoader,
  StatusBadge,
  StatusChip,
  Table,
  TBody,
  TD,
  TH,
  THead,
  TR,
  useUrlTab,
  ViewHeading,
  WaitBanner,
} from "@/design";
import { QueryBoundary } from "@/lib/api/query-boundary";
import { enumLabel, statusReading } from "@/design/vocabulary";
import { formatApiError } from "@/lib/api/error";
import { formatAge, formatNumber, formatRelative, formatWhen } from "@/lib/i18n/format";
import { useCopy, useInterfaceLanguage, useTimeFormat } from "@/lib/i18n/interface-language";
import { productCopy } from "@/lib/i18n/product-copy";
import { said } from "@/lib/i18n/said";
import { useMasterCharter, useMasterPasses, useMasterStanding, useRunStanding } from "../hooks";
import { runHref } from "@/lib/routes/agents";
import type { MasterClosedPass, MasterStanding, RunStanding } from "../types";
import { leaseLeft, recoveryText, runName } from "../view";
import { Passes } from "./master-passes";

export const masterName = (m: MasterStanding, language = "en") => m.name ?? productCopy(language)("agents.master.title");

function slotsText(m: MasterStanding, language: string): string {
  if (!m.slots) return "—";
  const t = productCopy(language);
  const slots = m.slots.max === null ? t("agents.master.slotsUnknown", { n: m.slots.inUse }) : t("agents.master.slotsOf", { n: m.slots.inUse, max: m.slots.max });
  const runs = m.slots.runs;
  return runs > 0 ? t(runs === 1 ? "agents.master.slotsRunsOne" : "agents.master.slotsRunsMany", { slots, n: runs }) : slots;
}

function doing(m: MasterStanding, language: string): string {
  const t = productCopy(language);
  if (m.state === "in_pass" && m.pass) return t("agents.master.doingPass", { verb: enumLabel("masterVerb", m.pass.verb, language).toLowerCase() });
  if (m.state === "runs_out") return t(m.runsOut === 1 ? "agents.master.doingRunsOne" : "agents.master.doingRunsMany", { n: m.runsOut });
  if (m.state === "idle") return t("agents.master.doingIdle");
  if (m.state === "waiting_person" && m.waitingOn) return said(m.waitingOn.says.act, language).toLowerCase();
  if (m.state === "silent") return t("agents.master.doingSilent", { when: m.lastBeatAt ? formatRelative(m.lastBeatAt, language) : t("agents.master.itsStart") });
  return t("agents.master.doingNone");
}

// ISS-276 / FB-87: a refusal's next try is the next nudge, never the reset the account printed; the
// pass that ran after refusals is the real recovery, and says so
const refusalLabel = (r: NonNullable<MasterClosedPass["refused"]>, language: string) => enumLabel("masterPassRefusal", r.reason, language).toLowerCase();

/** The last pass in one sentence; `bare` leaves off the lead a fact label already carries. */
export function lastPassText(m: Pick<MasterStanding, "lastPass">, language = "en", bare = false): string | null {
  const l = m.lastPass;
  if (!l) return null;
  const t = productCopy(language);
  if (l.refused) return t(bare ? "agents.master.lastRefusedValue" : "agents.master.lastRefused", { when: formatRelative(l.startedAt, language), why: refusalLabel(l.refused, language) });
  const ended = l.closeReason && l.closeReason !== "turn_ended" ? ` (${enumLabel("masterPassClose", l.closeReason, language).toLowerCase()})` : "";
  const recovered = l.recovers ? `, ${recoveryText(l.recovers, language)}` : "";
  return t(bare ? "agents.master.lastPassValue" : "agents.master.lastPass", { when: formatRelative(l.endedAt, language), ended, dispatched: l.dispatched.length, skipped: l.skipped.length, recovered });
}

// the box denies every permission dialog in a pane it placed and the run rephrases; how often is read here
function dialogsText(m: MasterStanding, language: string): string {
  const d = m.dialogsAnswered;
  if (!d) return "—";
  const count = `${formatNumber(d.count, language)}${d.countIsFloor ? "+" : ""}`;
  const when = d.lastAt ? productCopy(language)("agents.master.dialogLast", { when: formatRelative(d.lastAt, language) }) : "";
  return `${count}${when}${d.last ? `: ${d.last}` : ""}`;
}

// core keeps an outdated master and drives it; what its replacement waits on is read here (agent-run-standing, master)
function outdatedText(m: MasterStanding, language: string): string {
  const o = m.outdated;
  if (!o) return "—";
  const t = productCopy(language);
  // a record stored before core wrote its sentences carries only its English
  const held = o.says ? o.says.heldBy.map((h) => said(h, language)) : o.heldBy;
  return t("agents.master.outdated", { since: formatRelative(o.since, language), drain: o.draining ? t("agents.master.draining") : "", held: held.join("; ") });
}

/** Why core judges the pane outdated, in the reader's words where core said it. */
const outdatedWhy = (o: NonNullable<MasterStanding["outdated"]>, language: string): string => (o.says ? said(o.says.why, language) : o.why);

/** The master's one line: its name and what it is doing, and its state with its slots and last pass that state's hover. */
export function MasterLine({ m }: { m: MasterStanding }) {
  const t = useCopy();
  const language = useInterfaceLanguage();
  const reason = [t("agents.master.slotsFact", { slots: slotsText(m, language) }), lastPassText(m, language), m.lastBeatAt ? formatAge(m.lastBeatAt, language) : null].filter(Boolean).join(" · ");
  return (
    <>
      <span className="min-w-0 flex-1 truncate">{`${masterName(m, language)} · ${doing(m, language)}`}</span>
      <StatusChip family="masterState" value={m.state} reason={reason} />
    </>
  );
}

function MasterBanner({ m, className }: { m: MasterStanding; className?: string }) {
  const t = useCopy();
  const language = useInterfaceLanguage();
  const tone = m.state === "silent" ? "err" : m.state === "none" || m.state === "waiting_person" ? "you" : m.state === "in_pass" || m.state === "runs_out" ? "run" : "calm";
  const head = `${statusReading("masterState", m.state, language).label} ·`;
  const body =
    m.state === "in_pass" && m.pass
      ? t(m.pass.issueKey ? "agents.master.bannerPassOn" : "agents.master.bannerPass", { verb: enumLabel("masterVerb", m.pass.verb, language), when: formatRelative(m.pass.startedAt, language), key: m.pass.issueKey ?? "" })
      : m.state === "waiting_person" && m.waitingOn
        ? `${said(m.waitingOn.says.who, language)}: ${said(m.waitingOn.says.act, language)}`
        : m.state === "silent"
        ? t("agents.master.bannerSilent", { min: Math.round(m.silentAfterSeconds / 60) })
        : m.state === "none"
          ? t("agents.master.bannerNone")
          : (lastPassText(m, language) ?? t("agents.master.bannerNoPass"));
  return <WaitBanner tone={tone} head={head} body={body} className={className} testId="master-banner" />;
}

function SlotMarks({ m }: { m: MasterStanding }) {
  const t = useCopy();
  const max = m.slots?.max;
  const inUse = m.slots?.inUse ?? 0;
  if (max == null) return null;
  const marks = Array.from({ length: Math.max(max, inUse) }, (_, i) => ({
    key: String(i),
    label: t("agents.master.slotMark", { n: i + 1, state: i < inUse ? (i < max ? t("agents.master.slotInUse") : t("agents.master.slotOver")) : t("agents.master.slotFree") }),
    tone: i < inUse ? (i < max ? ("run" as const) : ("err" as const)) : undefined,
  }));
  return <MarkStrip marks={marks} />;
}

function MasterProperties({ m }: { m: MasterStanding }) {
  const t = useCopy();
  const language = useInterfaceLanguage();
  const time = useTimeFormat();
  return (
    <>
      <FactsGroup title={t("runs.fact.standing")}>
        <Fact label={t("runs.fact.state")}>
          <StatusBadge family="masterState" value={m.state} />
        </Fact>
        <Fact label={t("runs.fact.pass")}>
          {m.pass ? (
            <span title={time.dateTime(m.pass.startedAt)}>
              {enumLabel("masterVerb", m.pass.verb, language)} · {formatRelative(m.pass.startedAt, language)}
            </span>
          ) : (
            "—"
          )}
        </Fact>
        <Fact label={t("agents.master.lastPassFact")}>
          {m.lastPass ? <span title={time.dateTime(m.lastPass.endedAt)}>{lastPassText(m, language, true)}</span> : "—"}
        </Fact>
        <Fact label={t("agents.master.outdatedFact")}>{m.outdated ? <span title={outdatedWhy(m.outdated, language)}>{outdatedText(m, language)}</span> : "—"}</Fact>
      </FactsGroup>
      <FactsGroup title={t("agents.master.slots")}>
        <Fact label={t("agents.master.inUse")}>
          <span>{slotsText(m, language)}</span>
          <SlotMarks m={m} />
        </Fact>
        <Fact label={t("agents.master.max")}>
          {m.slots?.undeclared ? (
            <span className="text-danger" title={said(m.slots.undeclared.says.detail, language)}>
              {m.slots.undeclared.code}
            </span>
          ) : m.slots?.max != null ? (
            `${m.slots.max} (max_job_panes)`
          ) : (
            "—"
          )}
        </Fact>
      </FactsGroup>
      <FactsGroup title={t("runs.fact.box")}>
        <Fact label={t("runs.report.device")}>
          <span className="font-mono text-13">{m.device?.name ?? "—"}</span>
        </Fact>
        <Fact label={t("agents.master.lastBeat")}>{m.lastBeatAt ? <span title={time.dateTime(m.lastBeatAt)}>{formatRelative(m.lastBeatAt, language)}</span> : "—"}</Fact>
        <Fact label={t("runs.fact.since")}>{formatWhen(m.since, language)}</Fact>
        <Fact label={t("agents.master.dialogs")}>{dialogsText(m, language)}</Fact>
      </FactsGroup>
      <FactsGroup title={t("runs.fact.properties")}>
        <Fact label={t("runs.fact.session")}>
          {m.sessionId ? (
            <span className="font-mono text-13" title={m.sessionId}>
              {m.sessionId.slice(0, 8)}
            </span>
          ) : (
            "—"
          )}
        </Fact>
      </FactsGroup>
    </>
  );
}

/** What the master's line opens in place: what it waits on or is doing, its slots, its box, and its full page. */
export function MasterDetail({ m, href }: { m: MasterStanding; href: string }) {
  const t = useCopy();
  return (
    <div className="flex flex-col gap-3 pt-1" data-testid="master-detail">
      <div className="flex items-center gap-3">
        <MasterBanner m={m} className="min-w-0 flex-1" />
        <Link href={href} className="text-13 font-medium text-link hover:underline" data-testid="master-open">
          {t("agents.openPage")}
        </Link>
      </div>
      <div className="grid gap-x-8 md:grid-cols-2">
        <MasterProperties m={m} />
      </div>
    </div>
  );
}

const MASTER_TABS = ["passes", "runs", "charter"] as const;

function Leased({ m, projectId, slug }: { m: MasterStanding; projectId: string; slug: string }) {
  const t = useCopy();
  const language = useInterfaceLanguage();
  const time = useTimeFormat();
  const q = useRunStanding(projectId, "live");
  if (q.isLoading) return <ProjectLoader label={t("agents.loadingRuns")} />;
  if (q.isError || !q.data) return <ErrorState message={formatApiError(q.error)} onRetry={() => void q.refetch()} />;
  const rows = q.data.items.filter(
    (r: RunStanding) => r.holder.source === "held" && r.holder.dispatchedBy.source !== "none" && r.holder.dispatchedBy.masterSessionId === m.sessionId,
  );
  if (rows.length === 0) return <FactsEmpty>{t("agents.master.noLeased")}</FactsEmpty>;
  return (
    <section>
      <ViewHeading right={<span className="text-13 text-muted">{time.number(rows.length)}</span>}>{t("agents.master.leasedHeading")}</ViewHeading>
      <Table aria-label={t("agents.master.tab.runs")}>
        <THead className="bg-sunken">
          <TR>
            <TH>{t("runs.fact.run")}</TH>
            <TH>{t("runs.fact.standing")}</TH>
            <TH>{t("runs.fact.lease")}</TH>
            <TH>{t("runs.fact.pass")}</TH>
          </TR>
        </THead>
        <TBody>
          {rows.map((r) => {
            const d = r.holder.source === "held" ? r.holder.dispatchedBy : null;
            return (
              <TR key={r.id}>
                <TD>
                  <Link href={runHref(slug, r.id)} className="text-link hover:underline">
                    {runName(r, language)}
                  </Link>
                </TD>
                <TD>
                  <StatusBadge family="runStanding" value={r.state} />
                </TD>
                <TD>{leaseLeft(r, language) ?? "—"}</TD>
                <TD>
                  {d?.source === "pass" ? (
                    <span title={time.dateTime(d.startedAt)}>
                      {formatWhen(d.startedAt, language)} {enumLabel("masterVerb", d.verb, language).toLowerCase()}
                    </span>
                  ) : (
                    <span className="text-muted" title={d?.source === "master" ? said(d.says.detail, language) : undefined}>
                      {t("runs.notKnown")}
                    </span>
                  )}
                </TD>
              </TR>
            );
          })}
        </TBody>
      </Table>
    </section>
  );
}

function Charter({ projectId }: { projectId: string }) {
  const t = useCopy();
  const language = useInterfaceLanguage();
  const q = useMasterCharter(projectId, true);
  if (q.isLoading) return <ProjectLoader label={t("agents.master.loadingCharter")} />;
  if (q.isError || !q.data) return <ErrorState message={formatApiError(q.error)} onRetry={() => void q.refetch()} />;
  const c = q.data;
  if (!c.declared) return <FactsEmpty>{t("agents.master.noCharter")}</FactsEmpty>;
  return (
    <section>
      <ViewHeading right={c.declaredAt ? <span className="text-13 text-muted">{t("agents.master.declared", { at: formatWhen(c.declaredAt, language) })}</span> : undefined}>{t("agents.master.charterV", { v: c.version ?? "" })}</ViewHeading>
      {c.goal ? <p className="text-14">{c.goal}</p> : null}
      {c.rules.length > 0 ? (
        <ul className="mt-3 border-t border-line-subtle">
          {c.rules.map((rule) => (
            <li key={rule} className="border-b border-line-subtle py-2 text-13">
              {rule}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

export function MasterPage({ projectId, slug }: { projectId: string; slug: string }) {
  const t = useCopy();
  const language = useInterfaceLanguage();
  const q = useMasterStanding(projectId);
  const passes = useMasterPasses(projectId);
  const [tab, setTab] = useUrlTab(MASTER_TABS);
  return (
    <QueryBoundary query={q} loadingLabel={t("agents.master.loading")}>
      {(data) => {
        const m = data;
        const tabs = [
          { value: "passes" as const, label: t("agents.master.tab.passes"), ...(passes.data ? { count: passes.data.items.length } : {}) },
          { value: "runs" as const, label: t("agents.master.tab.runs") },
          { value: "charter" as const, label: t("agents.master.tab.charter") },
        ];
        // the face is the state, what it is doing and its passes, one line each; the standing, slots, box
        // and session are the Properties drawer's (ISS-903)
        return (
          <article className="min-h-full bg-app" data-testid="master-detail" data-key={m.sessionId ?? "none"}>
            <DetailMobileTitle itemKey={t("agents.master.word")} title={masterName(m, language)} badge={<StatusBadge family="masterState" value={m.state} />} />
            <MasterBanner m={m} className="px-8 py-2.5 max-md:px-4" />
            <div className="flex items-end justify-between gap-3 pr-8 max-md:pr-4" data-testid="master-tabs-bar">
              <div className="min-w-0 flex-1">
                <DetailTabs tabs={tabs} value={tab} onChange={setTab} testId="master-tabs" />
              </div>
              <DetailDrawer label={t("common.properties")} testId="master-properties">
                <FactsRail>
                  <MasterProperties m={m} />
                </FactsRail>
              </DetailDrawer>
            </div>
            <DetailPane label={tabs.find((x) => x.value === tab)?.label ?? t("agents.master.tab.passes")}>
              {tab === "passes" ? <Passes projectId={projectId} slug={slug} /> : null}
              {tab === "runs" ? <Leased m={m} projectId={projectId} slug={slug} /> : null}
              {tab === "charter" ? <Charter projectId={projectId} /> : null}
            </DetailPane>
          </article>
        );
      }}
    </QueryBoundary>
  );
}

"use client";

// the project master as masters/standing serves it (ISS-111, design agent-run-standing rev 1, region
// master): its state, open pass, last pass and slots are core's; the list row, the peek and the master page
// lay them out, and its passes come from masters/passes
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
  MarkStrip,
  PeekHead,
  PeekPanel,
  type PeekState,
  ProjectLoader,
  StatusBadge,
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
import { enumLabel, statusReading } from "@/design/vocabulary";
import { issueHref } from "@/lib/routes/issues";
import { formatApiError, isRetryableApiError } from "@/lib/api/error";
import { formatAge, formatRelativeTime, formatStamp } from "@/lib/utils/format";
import { useMasterCharter, useMasterPasses, useMasterStanding, useRunStanding } from "../hooks";
import { MASTER_KEY, runHref } from "@/lib/routes/agents";
import type { MasterPassView, MasterStanding, RunStanding } from "../types";
import { fmtTime, leaseLeft, runName } from "../view";

export const masterName = (m: MasterStanding) => m.name ?? "Project master";

function slotsText(m: MasterStanding): string {
  if (!m.slots) return "—";
  const slots = m.slots.max === null ? `${m.slots.inUse} of ?` : `${m.slots.inUse} of ${m.slots.max}`;
  return m.slots.runs > 0 ? `${slots} · ${m.slots.runs} declared run${m.slots.runs === 1 ? "" : "s"} beside them` : slots;
}

function doing(m: MasterStanding): string {
  if (m.state === "in_pass" && m.pass) return `working a ${enumLabel("masterVerb", m.pass.verb).toLowerCase()} pass`;
  if (m.state === "runs_out") return `between passes, ${m.runsOut} declared run${m.runsOut === 1 ? "" : "s"} out`;
  if (m.state === "idle") return "between passes";
  if (m.state === "waiting_person" && m.waitingOn) return m.waitingOn.act.toLowerCase();
  if (m.state === "silent") return `silent since ${m.lastBeatAt ? formatRelativeTime(m.lastBeatAt) : "its start"}`;
  return "no master serves this project";
}

function lastPassText(m: MasterStanding): string | null {
  const l = m.lastPass;
  if (!l) return null;
  if (l.refused) return `Last pass ${formatRelativeTime(l.endedAt)}: refused before it ran (${enumLabel("masterPassRefusal", l.refused.reason).toLowerCase()})`;
  const ended = l.closeReason && l.closeReason !== "turn_ended" ? ` (${enumLabel("masterPassClose", l.closeReason).toLowerCase()})` : "";
  return `Last pass ${formatRelativeTime(l.endedAt)}${ended}: dispatched ${l.dispatched.length}, skipped ${l.skipped.length}`;
}

// the box denies every permission dialog in a pane it placed and the run rephrases; how often is read here
function dialogsText(m: MasterStanding): string {
  const d = m.dialogsAnswered;
  if (!d) return "—";
  const count = `${d.count}${d.countIsFloor ? "+" : ""}`;
  const when = d.lastAt ? `, last ${formatRelativeTime(d.lastAt)}` : "";
  return `${count}${when}${d.last ? `: ${d.last}` : ""}`;
}

export const masterRow =
  (href: string) =>
  (m: MasterStanding): ListRowView => ({
    key: MASTER_KEY,
    keyLabel: "Master",
    href,
    title: `${masterName(m)} · ${doing(m)}`,
    facts: [`Slots ${slotsText(m)}`, lastPassText(m), m.pass?.issueKey ? `On ${m.pass.issueKey}` : null].filter((x): x is string => !!x),
    state: <StatusBadge family="masterState" value={m.state} />,
    waitingOn: <span className="text-12-5 text-subtle">—</span>,
    owner: m.device?.name ?? "No box",
    age: m.lastBeatAt ? { text: formatAge(m.lastBeatAt), title: `Last beat ${formatStamp(m.lastBeatAt)}` } : null,
  });

export function MasterBanner({ m, className }: { m: MasterStanding; className?: string }) {
  const tone = m.state === "silent" ? "err" : m.state === "none" || m.state === "waiting_person" ? "you" : m.state === "in_pass" || m.state === "runs_out" ? "run" : "calm";
  const head = `${statusReading("masterState", m.state).label} ·`;
  const body =
    m.state === "in_pass" && m.pass
      ? `${enumLabel("masterVerb", m.pass.verb)} since ${formatRelativeTime(m.pass.startedAt)}${m.pass.issueKey ? ` on ${m.pass.issueKey}` : ""}`
      : m.state === "waiting_person" && m.waitingOn
        ? `${m.waitingOn.who}: ${m.waitingOn.act}`
        : m.state === "silent"
        ? `the reaper fails it after ${Math.round(m.silentAfterSeconds / 60)} min of silence`
        : m.state === "none"
          ? "no live master session on any box serves this project"
          : (lastPassText(m) ?? "no pass recorded yet");
  return <WaitBanner tone={tone} head={head} body={body} className={className} testId="master-banner" />;
}

function SlotMarks({ m }: { m: MasterStanding }) {
  const max = m.slots?.max;
  const inUse = m.slots?.inUse ?? 0;
  if (max == null) return null;
  const marks = Array.from({ length: Math.max(max, inUse) }, (_, i) => ({
    key: String(i),
    label: `Slot ${i + 1} · ${i < inUse ? (i < max ? "in use" : "over the declared max") : "free"}`,
    tone: i < inUse ? (i < max ? ("run" as const) : ("err" as const)) : undefined,
  }));
  return <MarkStrip marks={marks} />;
}

export function MasterFacts({ m }: { m: MasterStanding }) {
  return (
    <>
      <FactsGroup title="Standing">
        <Fact label="State">
          <StatusBadge family="masterState" value={m.state} />
        </Fact>
        <Fact label="Pass">
          {m.pass ? (
            <span title={formatStamp(m.pass.startedAt)}>
              {enumLabel("masterVerb", m.pass.verb)} · {formatRelativeTime(m.pass.startedAt)}
            </span>
          ) : (
            "—"
          )}
        </Fact>
        <Fact label="Last pass">
          {m.lastPass ? <span title={formatStamp(m.lastPass.endedAt)}>{lastPassText(m)?.replace(/^Last pass /, "")}</span> : "—"}
        </Fact>
      </FactsGroup>
      <FactsGroup title="Slots">
        <Fact label="In use">
          <span>{slotsText(m)}</span>
          <SlotMarks m={m} />
        </Fact>
        <Fact label="Max">
          {m.slots?.undeclared ? (
            <span className="text-danger" title={m.slots.undeclared.detail}>
              {m.slots.undeclared.code}
            </span>
          ) : m.slots?.max != null ? (
            `${m.slots.max} (max_job_panes)`
          ) : (
            "—"
          )}
        </Fact>
      </FactsGroup>
      <FactsGroup title="Box">
        <Fact label="Device">
          <span className="font-mono text-12-5">{m.device?.name ?? "—"}</span>
        </Fact>
        <Fact label="Last beat">{m.lastBeatAt ? <span title={formatStamp(m.lastBeatAt)}>{formatRelativeTime(m.lastBeatAt)}</span> : "—"}</Fact>
        <Fact label="Since">{fmtTime(m.since)}</Fact>
        <Fact label="Dialogs answered">{dialogsText(m)}</Fact>
      </FactsGroup>
      <FactsGroup title="Properties">
        <Fact label="Session">
          {m.sessionId ? (
            <span className="font-mono text-12-5" title={m.sessionId}>
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

export function MasterPeek({ m, peek, onOpenFull }: { m: MasterStanding; peek: PeekState; onOpenFull: () => void }) {
  return (
    <PeekPanel peek={peek} listLabel="Agents / Runs" noun="Project master" onOpenFull={onOpenFull} testId="master-peek">
      <PeekHead noun="Project master" itemKey="Master" badge={<StatusBadge family="masterState" value={m.state} />} title={masterName(m)} />
      <MasterBanner m={m} className="px-[18px]" />
      <div className="px-[18px] pb-4 pt-4">
        <MasterFacts m={m} />
      </div>
    </PeekPanel>
  );
}

export const MASTER_TABS = ["passes", "runs", "charter"] as const;

const keyLink = (slug: string, k: string) =>
  /^[A-Z]+-\d+$/.test(k) ? (
    <Link href={issueHref(slug, k)} className="font-mono text-12-5 font-semibold text-link hover:underline">
      {k}
    </Link>
  ) : (
    <span>{k}</span>
  );

const keyList = (slug: string, keys: readonly string[]) =>
  keys.length === 0 ? (
    "—"
  ) : (
    <span className="inline-flex flex-wrap gap-x-2">
      {keys.map((k) => (
        <span key={k}>{keyLink(slug, k)}</span>
      ))}
    </span>
  );

function Passes({ projectId, slug }: { projectId: string; slug: string }) {
  const q = useMasterPasses(projectId);
  if (q.isLoading) return <ProjectLoader label="loading passes…" />;
  if (q.isError || !q.data) return <ErrorState message={formatApiError(q.error)} onRetry={() => q.refetch()} />;
  const items = q.data.items;
  if (items.length === 0) return <FactsEmpty>No pass is recorded for this project's master yet.</FactsEmpty>;
  const closed = (p: MasterPassView) => ("endedAt" in p ? p : null);
  return (
    <section>
      <ViewHeading hint={q.data.hasMore ? `the newest ${items.length}` : `${items.length}`}>Passes</ViewHeading>
      <Table aria-label="Passes">
        <THead className="bg-sunken">
          <TR>
            <TH>Started</TH>
            <TH>Verb</TH>
            <TH>Dispatched</TH>
            <TH>Skipped, with the refusal</TH>
            <TH>Parked</TH>
          </TR>
        </THead>
        <TBody>
          {items.map((p) => {
            const c = closed(p);
            return (
              <TR key={p.id}>
                <TD>
                  <span title={formatStamp(p.startedAt)}>{fmtTime(p.startedAt)}</span>
                  {c ? null : <span className="ml-1.5 text-12 font-semibold text-link">Now</span>}
                </TD>
                <TD>
                  <EnumBadge family="masterVerb" value={p.verb} />
                  {p.trigger === "unprompted" ? <span className="ml-1.5 text-12-5 text-muted" title="A turn the runner did not nudge: a person at the pane, or a task notification">unprompted</span> : null}
                </TD>
                <TD>
                  {c?.refused ? (
                    <span className="text-12-5 text-muted" title={c.refused.detail}>
                      Refused before it ran: {enumLabel("masterPassRefusal", c.refused.reason).toLowerCase()}
                    </span>
                  ) : c ? (
                    keyList(slug, c.dispatched)
                  ) : p.issueKey ? (
                    keyLink(slug, p.issueKey)
                  ) : (
                    "—"
                  )}
                </TD>
                <TD>
                  {c && c.skipped.length > 0 ? (
                    <ul className="grid gap-0.5">
                      {c.skipped.map((s) => (
                        <li key={s.issueKey}>
                          {keyLink(slug, s.issueKey)} <span className="text-12-5 text-muted">{s.refusal}</span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    "—"
                  )}
                </TD>
                <TD>{c ? keyList(slug, c.parked) : "—"}</TD>
              </TR>
            );
          })}
        </TBody>
      </Table>
    </section>
  );
}

function Leased({ m, projectId, slug }: { m: MasterStanding; projectId: string; slug: string }) {
  const q = useRunStanding(projectId, "live");
  if (q.isLoading) return <ProjectLoader label="loading runs…" />;
  if (q.isError || !q.data) return <ErrorState message={formatApiError(q.error)} onRetry={() => q.refetch()} />;
  const rows = q.data.items.filter(
    (r: RunStanding) => r.holder.source === "held" && r.holder.dispatchedBy.source !== "none" && r.holder.dispatchedBy.masterSessionId === m.sessionId,
  );
  if (rows.length === 0) return <FactsEmpty>No live run this master dispatched holds a lease.</FactsEmpty>;
  return (
    <section>
      <ViewHeading hint={`${rows.length}`}>Runs it dispatched that hold a lease</ViewHeading>
      <Table aria-label="Runs holding a lease">
        <THead className="bg-sunken">
          <TR>
            <TH>Run</TH>
            <TH>Standing</TH>
            <TH>Lease</TH>
            <TH>Pass</TH>
          </TR>
        </THead>
        <TBody>
          {rows.map((r) => {
            const d = r.holder.source === "held" ? r.holder.dispatchedBy : null;
            return (
              <TR key={r.id}>
                <TD>
                  <Link href={runHref(slug, r.id)} className="text-link hover:underline">
                    {runName(r)}
                  </Link>
                </TD>
                <TD>
                  <StatusBadge family="runStanding" value={r.state} />
                </TD>
                <TD>{leaseLeft(r) ?? "—"}</TD>
                <TD>
                  {d?.source === "pass" ? (
                    <span title={formatStamp(d.startedAt)}>
                      {fmtTime(d.startedAt)} {enumLabel("masterVerb", d.verb).toLowerCase()}
                    </span>
                  ) : (
                    <span className="text-muted" title={d?.source === "master" ? d.detail : undefined}>
                      Not known
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
  const q = useMasterCharter(projectId, true);
  if (q.isLoading) return <ProjectLoader label="loading the charter…" />;
  if (q.isError || !q.data) return <ErrorState message={formatApiError(q.error)} onRetry={() => q.refetch()} />;
  const c = q.data;
  if (!c.declared) return <FactsEmpty>No charter is declared for this project's master.</FactsEmpty>;
  return (
    <section>
      <ViewHeading hint={c.declaredAt ? `declared ${fmtTime(c.declaredAt)}` : undefined}>Charter v{c.version}</ViewHeading>
      {c.goal ? <p className="text-13-5">{c.goal}</p> : null}
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
  const q = useMasterStanding(projectId);
  const passes = useMasterPasses(projectId);
  const [tab, setTab] = useUrlTab(MASTER_TABS);
  if (q.isLoading) {
    return (
      <div className="grid min-h-[40vh] place-items-center">
        <ProjectLoader label="loading the master…" />
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
  const m = q.data;
  const tabs = [
    { value: "passes" as const, label: "Passes", ...(passes.data ? { count: passes.data.items.length } : {}) },
    { value: "runs" as const, label: "Runs holding a lease" },
    { value: "charter" as const, label: "Charter" },
  ];
  return (
    <DetailLayout
      testId="master-detail"
      dataKey={m.sessionId ?? "none"}
      rail={
        <FactsRail>
          <MasterFacts m={m} />
        </FactsRail>
      }
    >
      <DetailMobileTitle itemKey="Master" title={masterName(m)} badge={<StatusBadge family="masterState" value={m.state} />} />
      <MasterBanner m={m} className="px-8 py-2.5 max-md:px-4" />
      <DetailTabs tabs={tabs} value={tab} onChange={setTab} testId="master-tabs" />
      <DetailPane label={tabs.find((t) => t.value === tab)?.label ?? "Passes"}>
        {tab === "passes" ? <Passes projectId={projectId} slug={slug} /> : null}
        {tab === "runs" ? <Leased m={m} projectId={projectId} slug={slug} /> : null}
        {tab === "charter" ? <Charter projectId={projectId} /> : null}
      </DetailPane>
    </DetailLayout>
  );
}

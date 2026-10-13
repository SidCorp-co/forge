
import { HEALTH_MARKER_KINDS, type WorkflowHealth } from "@forge/contracts/workflow-health";
import type { WorkflowTemplate } from "@forge/contracts/workflow-templates";
import { Link, useRouter } from "@/lib/navigation/router";
import { Button, Fact, FactsEmpty, FactsGroup, StatusBadge, useRecordView } from "@/design";
import { formatApiError } from "@/lib/api/error";
import { refusalsOf } from "@/lib/api/refusals";
import { TONE_META } from "@/design/status";
import { issueHref } from "@/lib/routes/issues";
import { requirementHref } from "@/lib/routes/requirements";
import { useCopy, useInterfaceLanguage, useLabel, useTimeFormat } from "@/lib/i18n/interface-language";
import { said } from "@/lib/i18n/said";
import type { Copy } from "@/lib/i18n/product-copy";
import { revisionReason } from "../decision-words";
import { useDraftRequirementFromDesign } from "../hooks";
import { markersByKind, sourceHref, targetWords } from "../health";
import type { WorkflowBody, WorkflowDesign, WorkflowRecord } from "../types";
import { HealthMark } from "./health-parts";
import { SettleMarker } from "./settle-marker";

/**
 * The rail's Health group (REQ-17 BC-17): a count per marker kind, then the markers grouped by kind,
 * each opening its source record. Counts show whether or not the canvas overlay is on.
 */
function HealthGroup({ health, slug, projectId, canDecide }: { health: WorkflowHealth; slug: string; projectId: string | undefined; canDecide: boolean }) {
  const t = useCopy();
  const label = useLabel();
  const time = useTimeFormat();
  const language = useInterfaceLanguage();
  const total = health.markers.length;
  const groups = markersByKind(health.markers);
  return (
    <FactsGroup title={t("workflows.col.health")} count={total ? t("workflows.facts.markers", { n: total }) : undefined} testId="facts-health">
      {!health.rooted.rooted ? (
        <p className="mb-2 text-13 text-muted" data-testid="health-unrooted">
          {t("workflows.facts.unrooted", {
            why: health.rooted.missing
              .map((m) => (m === "approved_revision" ? t("workflows.facts.noApproved") : t("workflows.facts.noRequirement")))
              .join(t("workflows.facts.and")),
          })}
        </p>
      ) : health.observation === null ? (
        <p className="mb-2 text-13 text-muted" data-testid="health-not-observed">
          {t("workflows.facts.notObserved")}
        </p>
      ) : (
        <p className="mb-2 text-13 text-muted" title={time.dateTime(health.observation.createdAt)} data-testid="health-observed">
          {t("workflows.facts.observedAt")} <span className="font-mono">{health.observation.atSha.slice(0, 8)}</span>{" "}
          {t("workflows.facts.againstR", { r: health.observation.revision })} · {time.relative(health.observation.createdAt)}
        </p>
      )}
      <ul className="grid grid-cols-2 gap-x-3 gap-y-1" data-testid="health-counts">
        {HEALTH_MARKER_KINDS.map((k) => (
          <li key={k} className="flex min-w-0 items-center justify-between gap-2 text-13" data-kind={k} title={k}>
            <span className={health.counts[k] ? "text-fg" : "text-subtle"}>{label("healthMarker", k)}</span>
            <span className={`font-mono tabular-nums ${health.counts[k] ? "font-semibold" : "text-subtle"}`}>{health.counts[k]}</span>
          </li>
        ))}
      </ul>
      {health.needsYou > 0 ? (
        <p className="mt-2 text-13 font-semibold text-accent-text" data-testid="health-needs-you">
          {t("workflows.facts.needsPerson", { n: health.needsYou })}
        </p>
      ) : null}
      {groups.length ? (
        <div className="mt-2.5 border-t border-line-subtle" data-testid="health-markers">
          {groups.map((g) => (
            <details key={g.kind} className="border-b border-line-subtle py-1.5" data-kind={g.kind}>
              <summary className="flex cursor-pointer select-none items-center gap-2 text-13">
                <HealthMark kind={g.kind} />
              </summary>
              <ul className="mt-1 grid">
                {g.markers.map((m) => {
                  const href = sourceHref(slug, health.flow, m.source);
                  return (
                    <li key={`${m.rule}:${m.source.type}:${m.source.key}:${targetWords(m.target, t)}`} className="grid gap-0.5 border-t border-line-subtle py-1.5 text-13 first:border-t-0" data-testid="health-marker">
                      <span className="flex min-w-0 items-center gap-1.5">
                        {href ? (
                          <Link href={href} className="flex-none font-mono text-12 font-semibold text-link hover:underline" title={`${m.source.type} · ${m.rule}`}>
                            {m.source.key}
                          </Link>
                        ) : (
                          <span className="flex-none font-mono text-12 text-subtle" title={`${m.source.type} · ${m.rule}`}>
                            {m.source.key}
                          </span>
                        )}
                        <span className="min-w-0 truncate text-subtle">{targetWords(m.target, t)}</span>
                      </span>
                      <span className="text-muted">{said(m.says.reason, language)}</span>
                      {canDecide && projectId ? <SettleMarker projectId={projectId} flow={health.flow} marker={m} nodes={health.nodes} /> : null}
                    </li>
                  );
                })}
              </ul>
            </details>
          ))}
        </div>
      ) : null}
    </FactsGroup>
  );
}

/** design-reconciliation `reconciled-view`: the state, the dev version that carried it, and the BCs proven, read from core. */
function ReconciliationGroup({ health, slug }: { health: WorkflowHealth; slug: string }) {
  const t = useCopy();
  const time = useTimeFormat();
  const language = useInterfaceLanguage();
  const r = health.reconciliation;
  return (
    <FactsGroup title={t("workflows.facts.reconciliation")} testId="facts-reconciliation">
      <p className="mb-2 flex min-w-0 items-start gap-2 text-13 text-muted" data-testid="reconciliation-state" data-state={r.state}>
        <span className="flex-none">
          <StatusBadge family="reconciliation" value={r.state} />
        </span>
        <span className="min-w-0">{sentenceOf(said(r.says.rule, language))}</span>
      </p>
      <Fact label={t("workflows.facts.version")} testId="reconciliation-version">
        {r.version ? (
          <span className="font-mono text-13" title={r.version.releasedAt ? t("workflows.facts.releasedAt", { at: time.dateTime(r.version.releasedAt) }) : undefined}>
            {r.version.version}
          </span>
        ) : (
          <span className="text-muted">{t("workflows.facts.noVersion")}</span>
        )}
      </Fact>
      <Fact label={t("workflows.facts.bcsProven")} testId="reconciliation-criteria">
        {r.criteria.total === 0 ? (
          <span className="text-muted">{t("workflows.facts.noBc")}</span>
        ) : (
          <span className="font-mono tabular-nums text-13">
            {t("workflows.facts.of", { a: r.criteria.proven, b: r.criteria.total })}
          </span>
        )}
      </Fact>
      {r.issues.length ? (
        <Fact label={t("workflows.facts.carriedBy")} testId="reconciliation-issues">
          {r.issues.map((k) => (
            <Link key={k} href={issueHref(slug, k)} className="font-mono text-12 font-semibold text-link hover:underline">
              {k}
            </Link>
          ))}
        </Fact>
      ) : null}
    </FactsGroup>
  );
}

/**
 * FB-86: a design no requirement roots offers to draft one from it: a requirement titled after the
 * design and linked to it at birth, which the assistant then drafts from the design (REQ-34 BC-10).
 */
function DraftFromDesign({ projectId, slug, workflowId, flow, title }: { projectId: string; slug: string; workflowId: string; flow: string; title: string }) {
  const t = useCopy();
  const router = useRouter();
  const create = useDraftRequirementFromDesign(projectId, workflowId);
  const refused = create.error ? (refusalsOf(create.error)[0]?.detail ?? formatApiError(create.error)) : null;
  return (
    <div className="mt-2 grid gap-1">
      <Button size="sm" variant="secondary" loading={create.isPending} onClick={() => create.mutate({ title, designs: [flow] }, { onSuccess: (r) => router.push(requirementHref(slug, r.key)) })} data-testid="draft-from-design">
        {t("workflows.facts.draftRequirement")}
      </Button>
      {refused ? (
        <p role="alert" className="text-13 text-danger-11">
          {refused}
        </p>
      ) : null}
    </div>
  );
}

function Requirements({ d, slug, projectId, title, developer }: { d: WorkflowDesign; slug: string; projectId: string | undefined; title: string; developer: boolean }) {
  const t = useCopy();
  return (
    <FactsGroup title={t("workflows.facts.requirement")} count={d.requirements.length > 1 ? t("workflows.facts.linked", { n: d.requirements.length }) : undefined} testId="facts-requirement">
      {d.requirements.length === 0 ? (
        <>
          <FactsEmpty>{t("workflows.facts.noRequirementLinks")}</FactsEmpty>
          {projectId ? <DraftFromDesign projectId={projectId} slug={slug} workflowId={d.workflowId} flow={d.flow} title={title} /> : null}
        </>
      ) : (
        <ul className="grid gap-1.5">
          {d.requirements.map((r) => (
            <li key={r.key} className="flex min-w-0 items-center gap-1.5 text-13" data-testid="rail-requirement">
              <Link href={requirementHref(slug, r.key)} className="flex-none font-mono text-12 font-semibold text-link hover:underline">
                {r.key}
              </Link>
              <span className="min-w-0 flex-1 truncate" title={r.title}>
                {r.title}
              </span>
              {developer && r.pinnedRevision !== null ? <Pin r={r} approved={d.approvedRevision} /> : null}
              <StatusBadge family="requirement" value={r.state} />
            </li>
          ))}
        </ul>
      )}
    </FactsGroup>
  );
}

/** A rule as a sentence: capitalised, with its full stop. */
const sentenceOf = (s: string) => `${s.charAt(0).toUpperCase()}${s.slice(1)}.`;

/** The revision a requirement's agreed baseline pins, marked where it lags the approved one. */
function Pin({ r, approved }: { r: WorkflowDesign["requirements"][number]; approved: number | null }) {
  const t = useCopy();
  const pinned = r.pinnedRevision ?? 0;
  const lags = approved !== null && pinned < approved;
  return (
    <span
      className="flex-none font-mono text-12"
      style={lags ? { color: TONE_META.attention.fg } : undefined}
      title={lags ? t("workflows.facts.pinLags", { key: r.key, r: pinned, approved }) : t("workflows.facts.pinned", { key: r.key, r: pinned })}
      data-testid="rail-requirement-pin"
      data-lags={lags}
    >
      r{pinned}
    </span>
  );
}

/** The revision approved when the issue was linked as a build, marked where a later one is approved now. */
function BuiltAgainst({ b, approved }: { b: WorkflowDesign["builds"][number]; approved: number | null }) {
  const t = useCopy();
  if (b.builtAgainst === null) return null;
  const behind = approved !== null && b.builtAgainst < approved;
  return (
    <span
      className="flex-none font-mono text-12"
      style={behind ? { color: TONE_META.attention.fg } : undefined}
      title={behind ? t("workflows.facts.builtBehind", { r: b.builtAgainst, approved }) : t("workflows.facts.builtAgainst", { r: b.builtAgainst })}
      data-testid="rail-build-revision"
      data-behind={behind}
    >
      r{b.builtAgainst}
    </span>
  );
}

function BuildGate({ d, slug }: { d: WorkflowDesign; slug: string }) {
  const t = useCopy();
  const language = useInterfaceLanguage();
  return (
    <FactsGroup title={t("workflows.facts.buildGate")} count={d.builds.length ? t("workflows.facts.issues", { n: d.builds.length }) : undefined} testId="facts-build-gate">
      <p className="mb-2 flex min-w-0 items-start gap-2 text-13 text-muted" data-testid="build-gate" data-open={d.gate.open}>
        <span className="flex-none">
          <StatusBadge family="buildGate" value={d.gate.open ? "open" : "held"} />
        </span>
        <span className="min-w-0">{sentenceOf(said(d.gate.says.rule, language))}</span>
      </p>
      {d.builds.length === 0 ? (
        <FactsEmpty>{t("workflows.facts.noBuild")}</FactsEmpty>
      ) : (
        <ul className="grid gap-1.5">
          {d.builds.map((b) => (
            <li key={b.issueId} className="flex min-w-0 items-center gap-1.5 text-13" data-testid="rail-build">
              <Link href={issueHref(slug, b.displayId)} className="flex-none font-mono text-12 font-semibold text-link hover:underline">
                {b.displayId}
              </Link>
              <span className="min-w-0 flex-1 truncate" title={b.title}>
                {b.title}
              </span>
              <BuiltAgainst b={b} approved={d.approvedRevision} />
              <StatusBadge family="issue" value={b.status} />
            </li>
          ))}
        </ul>
      )}
    </FactsGroup>
  );
}

/** What the design's health says, in a BA's words; the kernel's terms sit behind Technical detail. */
export function healthSentences(health: WorkflowHealth, t: Copy): string[] {
  const out: string[] = [];
  if (!health.rooted.rooted) {
    const why = health.rooted.missing.map((m) => (m === "approved_revision" ? t("workflows.plain.noApproved") : t("workflows.plain.noRequirement")));
    out.push(t("workflows.plain.notCompared", { why: why.join(t("workflows.facts.and")) }));
  } else if (health.observation === null) {
    out.push(t("workflows.plain.notComparedYet"));
  } else {
    const n = health.markers.length;
    out.push(n === 0 ? t("workflows.plain.agrees") : t(n === 1 ? "workflows.plain.differs.one" : "workflows.plain.differs.many", { n }));
  }
  if (health.needsYou > 0) {
    out.push(t(health.needsYou === 1 ? "workflows.plain.needDecide.one" : "workflows.plain.needDecide.many", { n: health.needsYou }));
  }
  return out;
}

/** Whether the code and the approved design are confirmed to match, as one sentence. */
export function reconciliationSentence(health: WorkflowHealth, t: Copy): string {
  const r = health.reconciliation;
  if (r.state === "reconciled") return r.version ? t("workflows.plain.matchesReleased", { version: r.version.version }) : t("workflows.plain.matches");
  return t("workflows.plain.notConfirmed");
}

/** Whether work may start from the design, as one sentence. */
export function buildGateSentence(d: WorkflowDesign, t: Copy): string {
  return d.gate.open ? t("workflows.plain.canStart") : t("workflows.plain.onHold");
}

function PlainStatus({ d, health }: { d: WorkflowDesign; health: WorkflowHealth | undefined }) {
  const t = useCopy();
  return (
    <FactsGroup title={t("workflows.facts.whereItStands")} testId="facts-plain-status">
      <ul className="grid gap-1 text-13 leading-relaxed-1-6" data-testid="plain-status">
        {health ? healthSentences(health, t).map((s) => <li key={s}>{s}</li>) : null}
        {health ? <li>{reconciliationSentence(health, t)}</li> : null}
        <li>{buildGateSentence(d, t)}</li>
      </ul>
    </FactsGroup>
  );
}

/** The kernel's own terms for the same facts (markers, reconciliation state, build gate): the Developer view's (REQ-43 BC-7). */
function TechnicalDetail({ d, slug, health, projectId }: { d: WorkflowDesign; slug: string; health: WorkflowHealth | undefined; projectId: string | undefined }) {
  const t = useCopy();
  return (
    <section aria-label={t("workflows.technicalDetail")} data-testid="design-technical">
      {health ? <HealthGroup health={health} slug={slug} projectId={projectId} canDecide={d.canDecide} /> : null}
      {health ? <ReconciliationGroup health={health} slug={slug} /> : null}
      <BuildGate d={d} slug={slug} />
    </section>
  );
}

interface DesignFactsProps {
  d: WorkflowDesign;
  record: WorkflowRecord;
  shown: WorkflowBody;
  shownRevision: number;
  template: WorkflowTemplate | null;
  slug: string;
  health: WorkflowHealth | undefined;
  projectId?: string | undefined;
}

/** Who approved the design: a person's view names them, the developer view the revision and its note too. */
function ApprovedFact({ d, developer }: { d: WorkflowDesign; developer: boolean }) {
  const t = useCopy();
  const time = useTimeFormat();
  const language = useInterfaceLanguage();
  const approved = d.revisions.find((r) => r.revision === d.approvedRevision) ?? null;
  const approvedReason = approved ? revisionReason(approved, language) : null;
  const approvedAt = approved?.decidedAt ? t("workflows.facts.approvedAt", { at: time.dateTime(approved.decidedAt) }) : undefined;
  return (
    <Fact label={t("workflows.facts.approved")} testId="fact-approved">
      {approved && !developer ? (
        <span title={approvedAt}>{approved.decidedByName ?? (approved.decidedAt ? time.relative(approved.decidedAt) : t("workflows.facts.approved"))}</span>
      ) : approved ? (
        <span className="grid min-w-0 basis-full gap-0.5">
          <span title={approvedAt}>
            {approved.decidedByName ? t("workflows.facts.revBy", { r: approved.revision, who: approved.decidedByName }) : t("workflows.facts.rev", { r: approved.revision })}
          </span>
          {approvedReason ? (
            <span className="line-clamp-4 whitespace-pre-wrap break-words text-13 text-muted" title={approvedReason} data-testid="fact-approved-note">
              {approvedReason}
            </span>
          ) : null}
        </span>
      ) : d.approvedRevision !== null ? (
        <span>{developer ? t("workflows.facts.rev", { r: d.approvedRevision }) : t("workflows.facts.approved")}</span>
      ) : (
        <span className="text-muted">{t("workflows.facts.notApproved")}</span>
      )}
    </Fact>
  );
}

export function WorkflowDesignProperties({ d, record, shown, shownRevision, template, slug, health, projectId }: DesignFactsProps) {
  const t = useCopy();
  const time = useTimeFormat();
  const [view] = useRecordView();
  const developer = view === "developer";
  const latest = d.revisions[0] ?? null;
  const shownState = d.revisions.find((r) => r.revision === shownRevision)?.state ?? null;
  const owned = shown.steps.filter((s) => s.node?.owner).length;
  const deadlines = shown.steps.filter((s) => s.node?.sla).length;
  const unit = shown.kind === "state" ? "states" : "steps";
  return (
    <div data-testid="design-facts">
      {shown.summary ? (
        <FactsGroup title={t("workflows.facts.about")} testId="facts-about">
          <p className="line-clamp-5 text-13 leading-relaxed-1-6 text-fg" title={shown.summary} data-testid="design-summary">
            {shown.summary}
          </p>
        </FactsGroup>
      ) : null}
      <PlainStatus d={d} health={health} />
      <Requirements d={d} slug={slug} projectId={projectId} title={shown.title} developer={developer} />
      <FactsGroup title={t("workflows.facts.properties")} testId="facts-properties">
        {/* the header badge says the design's state; the revision number and its state are the Developer view's (REQ-43 BC-5, BC-7) */}
        {developer ? (
          <Fact label={t("workflows.facts.revision")} testId="fact-revision">
            <span className="font-mono text-13">r{shownRevision}</span>
            {shownState ? <StatusBadge family="designRevision" value={shownState} /> : null}
          </Fact>
        ) : null}
        <ApprovedFact d={d} developer={developer} />
        {developer ? (
          <Fact label={t("workflows.facts.approver")}>
            <span>{t("workflows.facts.approverAnyone")}</span>
          </Fact>
        ) : null}
        <Fact label={t("workflows.facts.template")}>
          <span title={template ? `${template.id}@${template.version}` : undefined}>{template?.title ?? t("workflows.facts.none")}</span>
        </Fact>
        {/* the Steps tab counts them; the rail says only how many have an owner and a deadline (REQ-43 BC-5) */}
        <Fact label={unit === "states" ? t("workflows.tab.states") : t("workflows.tab.steps")} testId="fact-steps">
          <span>
            {t("workflows.facts.withOwner", { n: owned })} · {t(deadlines === 1 ? "workflows.count.deadline.one" : "workflows.count.deadline.many", { n: deadlines })}
          </span>
        </Fact>
        <Fact label={t("workflows.facts.drawnBy")}>
          <span title={latest ? t("workflows.facts.proposedAt", { at: time.dateTime(latest.proposedAt) }) : undefined}>{latest ? (latest.proposedByName ?? latest.proposedBy) : record.writerName}</span>
        </Fact>
        <Fact label={t("workflows.col.updated")}>
          <span title={time.dateTime(record.document.updatedAt)}>{time.relative(record.document.updatedAt)}</span>
        </Fact>
      </FactsGroup>
      {developer ? <TechnicalDetail d={d} slug={slug} health={health} projectId={projectId} /> : null}
    </div>
  );
}

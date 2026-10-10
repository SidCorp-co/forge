"use client";

import { useState } from "react";
import { Button, DetailLayout, DetailMobileTitle, DetailPane, DetailTabs, EnumBadge, FactsRail, RecordViewSwitch, RowItem, RowList, StatusBadge, Textarea, useRecordView, ViewHeading } from "@/design";
import { formatApiError } from "@/lib/api/error";
import { useCopy } from "@/lib/i18n/interface-language";
import { formatStamp } from "@/lib/utils/format";
import { useDecideVersion } from "../hooks";
import type { ContractStandingDetail, ContractVersionView } from "../types";
import { AdoptionStrip, ContractBanner } from "./contract-bits";
import { ContractProperties } from "./contract-facts";
import { VersionTimeline } from "./version-timeline";

export const CONTRACT_TABS = ["overview", "versions", "adoption"] as const;
type ContractTab = (typeof CONTRACT_TABS)[number];

// The overview is the contract's state beside the header and the rail (REQ-43 BC-5): its summary, how
// many consumers are on the latest version, and its versions in time. The provider, the state and the
// current version are the rail's and the header's; the consumer rows and the version table are their
// tabs', so none is said here a second time.
function Overview({ d }: { d: ContractStandingDetail }) {
  const t = useCopy();
  const c = d.contract;
  return (
    <div className="grid gap-8" data-testid="view-overview">
      {c.summary ? <p className="max-w-prose text-15 leading-relaxed text-fg">{c.summary}</p> : null}
      <section>
        <ViewHeading right={<AdoptionStrip consumers={d.consumers} latest={c.current?.version ?? null} />}>{t("contracts.pcc.consumers")}</ViewHeading>
      </section>
      <section>
        <ViewHeading>{t("contracts.tab.versions")}</ViewHeading>
        <VersionTimeline row={c} versions={d.versions} />
      </section>
    </div>
  );
}

const VERSION_COLS = "flex flex-wrap gap-x-3.5 px-3";
const COL = { version: "w-24 flex-none", recorded: "w-28 flex-none max-md:hidden", changes: "min-w-0 flex-1", approval: "w-36 flex-none max-md:hidden" } as const;

function Decide({ d, v, projectId }: { d: ContractStandingDetail; v: ContractVersionView; projectId: string }) {
  const t = useCopy();
  const m = useDecideVersion(projectId, d.contract.slug);
  const [returning, setReturning] = useState(false);
  const [reason, setReason] = useState("");
  return (
    <div className="grid basis-full gap-2 pb-3 pt-1" data-testid="decide-version">
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="primary" size="sm" disabled={m.isPending} onClick={() => m.mutate({ version: v.version, decision: "approve" })} data-testid="approve-version">
          {t("contracts.decide.approve", { v: v.version })}
        </Button>
        <Button type="button" variant="secondary" size="sm" disabled={m.isPending} onClick={() => setReturning((r) => !r)}>
          {t("contracts.decide.return")}
        </Button>
      </div>
      {returning ? (
        <div className="grid max-w-140 gap-2">
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder={t("contracts.decide.reasonPlaceholder")} rows={3} />
          <div>
            <Button type="button" size="sm" disabled={m.isPending || reason.trim().length === 0} onClick={() => m.mutate({ version: v.version, decision: "return", reason: reason.trim() })}>
              {t("contracts.decide.returnV", { v: v.version })}
            </Button>
          </div>
        </div>
      ) : null}
      {m.isError ? <p className="text-12-5 text-danger">{formatApiError(m.error)}</p> : null}
    </div>
  );
}

function Versions({ d, projectId, developer }: { d: ContractStandingDetail; projectId: string; developer: boolean }) {
  const t = useCopy();
  const c = d.contract;
  const decidable = c.attentionGroup === "needs_you" && c.waitingOn.kind === "you" && c.pending?.version === c.waitingOn.ref;
  return (
    <div data-testid="view-versions">
      <ViewHeading>{t("contracts.versions.history")}</ViewHeading>
      {d.versions.length === 0 ? (
        <p className="text-13 text-subtle">{t("contracts.versions.none")}</p>
      ) : (
        <>
          <div className={`${VERSION_COLS} h-8 items-center border-y border-line-subtle bg-sunken text-11-5 font-semibold text-subtle`} aria-hidden>
            <span className={COL.version}>{t("contracts.versions.colVersion")}</span>
            <span className={COL.recorded}>{t("contracts.versions.colRecorded")}</span>
            <span className={COL.changes}>{t("contracts.versions.colChanges")}</span>
            <span className={COL.approval}>{t("contracts.versions.colApproval")}</span>
          </div>
          <ul>
            {d.versions.map((v) => (
              <li key={v.version} className={`${VERSION_COLS} items-baseline border-b border-line-subtle py-2.5 text-13`} data-testid="version-row">
                <span className={`${COL.version} font-mono text-12-5 font-semibold`}>{v.version}</span>
                <span className={`${COL.recorded} text-12 text-muted`} title={formatStamp(v.recordedAt)}>
                  {v.recordedAt.slice(0, 10)}
                </span>
                <span className={COL.changes}>
                  <span className="inline-flex flex-wrap items-center gap-1.5">
                    <StatusBadge family="classification" value={v.classification} />
                    {v.previous ? <span className="text-12 text-subtle">{t("contracts.versions.after", { v: v.previous })}</span> : null}
                  </span>
                  {v.changes.length > 0 ? (
                    <details className="mt-1">
                      <summary className="cursor-pointer select-none text-12-5 font-medium text-muted hover:text-fg">
                        {t(v.changes.length === 1 ? "contracts.versions.changeOne" : "contracts.versions.changeMany", { n: v.changes.length })}
                      </summary>
                      <ul className="mt-1 grid gap-1">
                        {v.changes.map((ch) => (
                          <li key={`${ch.element}${ch.kind}${ch.text}`} className="break-words text-12-5" data-testid="version-change">
                            {developer ? (
                              <>
                                <code className="font-mono">{ch.element}</code> <EnumBadge family="changeKind" value={ch.kind} /> <StatusBadge family="changeLevel" value={ch.level} />{" "}
                              </>
                            ) : null}
                            {ch.text}
                          </li>
                        ))}
                      </ul>
                    </details>
                  ) : null}
                </span>
                <span className={COL.approval} title={v.decisionReason ?? (v.decidedAt ? t("contracts.versions.decided", { when: formatStamp(v.decidedAt) }) : undefined)}>
                  <StatusBadge family="contractApproval" value={v.approval} />
                </span>
                {decidable && v.approval === "proposed" ? <Decide d={d} v={v} projectId={projectId} /> : null}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function Adoption({ d }: { d: ContractStandingDetail }) {
  const t = useCopy();
  const c = d.contract;
  return (
    <div className="grid gap-8" data-testid="view-adoption">
      <section>
        <ViewHeading right={<AdoptionStrip consumers={d.consumers} latest={c.current?.version ?? null} />}>{t("contracts.adoption.heading")}</ViewHeading>
        {d.consumers.length === 0 ? (
          <p className="text-13 text-subtle">{t("contracts.consumers.none")}</p>
        ) : (
          <RowList>
            {d.consumers.map((x) => (
              <RowItem
                key={x.project.id}
                testId="adoption-row"
                title={x.project.slug}
                lead={x.self ? <span className="text-12 text-subtle">{t("contracts.thisProject")}</span> : undefined}
                facts={[<span key="v" className="font-mono">{x.builtAgainst}</span>]}
                trailing={<StatusBadge family="contractAdoption" value={x.adoption} />}
              />
            ))}
          </RowList>
        )}
      </section>
    </div>
  );
}

export function ContractPage({ d, slug, projectId, tab, onTab }: { d: ContractStandingDetail; slug: string; projectId: string; tab: ContractTab; onTab: (t: ContractTab) => void }) {
  const t = useCopy();
  const [view, onView] = useRecordView();
  const developer = view === "developer";
  const c = d.contract;
  const tabs = [
    { value: "overview" as const, label: t("contracts.tab.overview") },
    { value: "versions" as const, label: t("contracts.tab.versions"), count: d.versions.length },
    { value: "adoption" as const, label: t("contracts.tab.adoption"), count: d.consumers.length },
  ];
  const shown = tabs.some((x) => x.value === tab) ? tab : "overview";
  return (
    <DetailLayout
      testId="contract-detail"
      dataKey={c.ref}
      rail={
        <FactsRail testId="relations-rail">
          <ContractProperties d={d} slug={slug} developer={developer} />
        </FactsRail>
      }
    >
      <DetailMobileTitle itemKey={c.ref} title={c.title} badge={<StatusBadge family="contractState" value={c.state} />} />
      <ContractBanner row={c} slug={slug} className="px-8 py-2.5 max-md:px-4" />
      <div className="flex justify-end px-8 pt-3 max-md:px-4" data-testid="contract-view-bar">
        <RecordViewSwitch view={view} onView={onView} />
      </div>
      <DetailTabs tabs={tabs} value={shown} onChange={onTab} testId="contract-tabs" />
      <DetailPane label={tabs.find((x) => x.value === shown)?.label ?? t("contracts.tab.overview")}>
        {shown === "overview" ? <Overview d={d} /> : null}
        {shown === "versions" ? <Versions d={d} projectId={projectId} developer={developer} /> : null}
        {shown === "adoption" ? <Adoption d={d} /> : null}
      </DetailPane>
    </DetailLayout>
  );
}

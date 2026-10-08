"use client";

import { useState } from "react";
import {
  Button,
  DetailLayout,
  DetailMobileTitle,
  DetailPane,
  DetailTabs,
  EnumBadge,
  FactsRail,
  FieldLabel,
  StatusBadge,
  Textarea,
  ViewHeading,
} from "@/design";
import { formatApiError } from "@/lib/api/error";
import { useCopy } from "@/lib/i18n/interface-language";
import { formatStamp } from "@/lib/utils/format";
import { useDecideVersion } from "../hooks";
import type { ContractConsumerView, ContractStandingDetail, ContractVersionView } from "../types";
import { AdoptionStrip, ContractBanner } from "./contract-bits";
import { ContractFacts } from "./contract-facts";
import { VersionTimeline } from "./version-timeline";

export const CONTRACT_TABS = ["overview", "versions", "adoption"] as const;
type ContractTab = (typeof CONTRACT_TABS)[number];

function Party({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <FieldLabel>{label}</FieldLabel>
      <div className="grid gap-2 border-t border-line-subtle pt-2">{children}</div>
    </div>
  );
}

function ConsumerLine({ c }: { c: ContractConsumerView }) {
  const t = useCopy();
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-13" data-testid="pcc-consumer">
      <b className="font-semibold">{c.project.slug}</b>
      {c.self ? <span className="text-12 text-subtle">{t("contracts.thisProject")}</span> : null}
      <span className="font-mono text-12-5 text-muted">{t("contracts.onVersion", { v: c.builtAgainst })}</span>
      <StatusBadge family="contractAdoption" value={c.adoption} />
    </div>
  );
}

function Overview({ d }: { d: ContractStandingDetail }) {
  const t = useCopy();
  const c = d.contract;
  return (
    <div className="grid gap-8" data-testid="view-overview">
      {c.summary ? <p className="max-w-[80ch] text-15 leading-relaxed text-fg">{c.summary}</p> : null}
      <section>
        <ViewHeading>{t("contracts.pcc.heading")}</ViewHeading>
        <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)_auto_minmax(0,1.3fr)] items-start gap-x-4 max-md:grid-cols-1 max-md:gap-y-4" data-testid="pcc">
          <Party label={t("contracts.pcc.provider")}>
            <div className="text-13">
              <b className="font-semibold">{c.provider.slug}</b>
              {c.direction === "provided" ? <span className="ml-2 text-12 text-subtle">{t("contracts.thisProject")}</span> : c.provider.name !== c.provider.slug ? <span className="ml-2 text-12 text-subtle">{c.provider.name}</span> : null}
            </div>
          </Party>
          <span aria-hidden className="pt-8 text-muted max-md:hidden">→</span>
          <Party label={t("contracts.pcc.contract")}>
            <div className="grid gap-1 text-13">
              <span className="font-mono font-semibold">{c.slug}</span>
              <span className="font-mono text-12-5 text-muted">
                {c.current?.version ?? t("contracts.version.noneLower")}
                {c.pending ? ` → ${t("contracts.version.proposed", { v: c.pending.version })}` : ""}
              </span>
              <span>
                <StatusBadge family="contractState" value={c.state} />
              </span>
            </div>
          </Party>
          <span aria-hidden className="pt-8 text-muted max-md:hidden">→</span>
          <Party label={t("contracts.pcc.consumers")}>
            {d.consumers.length === 0 ? <span className="text-13 text-subtle">{t("contracts.consumers.none")}</span> : d.consumers.map((x) => <ConsumerLine key={x.project.id} c={x} />)}
          </Party>
        </div>
      </section>
      <section>
        <ViewHeading right={<span className="text-12 text-subtle">{t("contracts.versions.recorded", { n: d.versions.length })}</span>}>{t("contracts.tab.versions")}</ViewHeading>
        <VersionTimeline row={c} versions={d.versions} />
      </section>
    </div>
  );
}

const VERSION_COLS = "grid grid-cols-[110px_120px_minmax(0,1fr)_150px] gap-x-3.5 px-3 max-md:grid-cols-[90px_minmax(0,1fr)]";

function Decide({ d, v, projectId }: { d: ContractStandingDetail; v: ContractVersionView; projectId: string }) {
  const t = useCopy();
  const m = useDecideVersion(projectId, d.contract.slug);
  const [returning, setReturning] = useState(false);
  const [reason, setReason] = useState("");
  return (
    <div className="col-span-full grid gap-2 pb-3 pt-1" data-testid="decide-version">
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="primary" size="sm" disabled={m.isPending} onClick={() => m.mutate({ version: v.version, decision: "approve" })} data-testid="approve-version">
          {t("contracts.decide.approve", { v: v.version })}
        </Button>
        <Button type="button" variant="secondary" size="sm" disabled={m.isPending} onClick={() => setReturning((r) => !r)}>
          {t("contracts.decide.return")}
        </Button>
        {v.classification === "breaking" ? (
          <span className="text-12 text-muted">{t("contracts.decide.breakingNote")}</span>
        ) : null}
      </div>
      {returning ? (
        <div className="grid max-w-[560px] gap-2">
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

function Versions({ d, projectId }: { d: ContractStandingDetail; projectId: string }) {
  const t = useCopy();
  const c = d.contract;
  const decidable = c.attentionGroup === "needs_you" && c.waitingOn.kind === "you" && c.pending?.version === c.waitingOn.ref;
  return (
    <div data-testid="view-versions">
      <ViewHeading right={<span className="text-12 text-subtle">{c.direction === "consumed" ? t("contracts.versions.approvedOnly") : t("contracts.versions.everyRecorded")}</span>}>{t("contracts.versions.history")}</ViewHeading>
      {d.versions.length === 0 ? (
        <p className="text-13 text-subtle">{t("contracts.versions.none")}</p>
      ) : (
        <>
          <div className={`${VERSION_COLS} h-8 items-center border-y border-line-subtle bg-sunken text-11-5 font-semibold text-subtle`} aria-hidden>
            <span>{t("contracts.versions.colVersion")}</span>
            <span className="max-md:hidden">{t("contracts.versions.colRecorded")}</span>
            <span>{t("contracts.versions.colChanges")}</span>
            <span className="max-md:hidden">{t("contracts.versions.colApproval")}</span>
          </div>
          <ul>
            {d.versions.map((v) => (
              <li key={v.version} className={`${VERSION_COLS} items-baseline border-b border-line-subtle py-2.5 text-13`} data-testid="version-row">
                <span className="font-mono text-12-5 font-semibold">{v.version}</span>
                <span className="text-12 text-muted max-md:hidden" title={formatStamp(v.recordedAt)}>
                  {v.recordedAt.slice(0, 10)}
                </span>
                <span className="min-w-0">
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
                          <li key={`${ch.element}${ch.kind}${ch.text}`} className="break-words text-12-5">
                            <code className="font-mono">{ch.element}</code> <EnumBadge family="changeKind" value={ch.kind} /> <StatusBadge family="changeLevel" value={ch.level} /> {ch.text}
                          </li>
                        ))}
                      </ul>
                    </details>
                  ) : null}
                </span>
                <span className="max-md:hidden" title={v.decisionReason ?? (v.decidedAt ? t("contracts.versions.decided", { when: formatStamp(v.decidedAt) }) : undefined)}>
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
          <ul className="border-t border-line-subtle">
            {d.consumers.map((x) => (
              <li key={x.project.id} className="grid grid-cols-[minmax(0,1fr)_120px_140px] items-center gap-x-3 border-b border-line-subtle px-3 py-2.5 text-13" data-testid="adoption-row">
                <span className="min-w-0 truncate">
                  <b className="font-semibold">{x.project.slug}</b>
                  {x.self ? <span className="ml-2 text-12 text-subtle">{t("contracts.thisProject")}</span> : null}
                </span>
                <span className="font-mono text-12-5">{x.builtAgainst}</span>
                <StatusBadge family="contractAdoption" value={x.adoption} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

export function ContractPage({ d, slug, projectId, tab, onTab }: { d: ContractStandingDetail; slug: string; projectId: string; tab: ContractTab; onTab: (t: ContractTab) => void }) {
  const t = useCopy();
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
          <ContractFacts d={d} slug={slug} />
        </FactsRail>
      }
    >
      <DetailMobileTitle itemKey={c.ref} title={c.title} badge={<StatusBadge family="contractState" value={c.state} />} />
      <ContractBanner row={c} slug={slug} className="px-8 py-2.5 max-md:px-4" />
      <DetailTabs tabs={tabs} value={shown} onChange={onTab} testId="contract-tabs" />
      <DetailPane label={tabs.find((x) => x.value === shown)?.label ?? t("contracts.tab.overview")}>
        {shown === "overview" ? <Overview d={d} /> : null}
        {shown === "versions" ? <Versions d={d} projectId={projectId} /> : null}
        {shown === "adoption" ? <Adoption d={d} /> : null}
      </DetailPane>
    </DetailLayout>
  );
}

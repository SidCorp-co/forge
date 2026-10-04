"use client";

import Link from "next/link";
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
  useUrlTab,
  ViewHeading,
} from "@/design";
import { requirementHref } from "@/features/requirements/routes";
import { formatApiError } from "@/lib/api/error";
import { formatStamp } from "@/lib/utils/format";
import { useDecideVersion } from "../hooks";
import type { ContractConsumerView, ContractStandingDetail, ContractVersionView } from "../types";
import { AdoptionStrip, ContractBanner, ContractStateBadge } from "./contract-bits";
import { ContractFacts } from "./contract-facts";
import { VersionTimeline } from "./version-timeline";

export const CONTRACT_TABS = ["overview", "versions", "adoption", "measurements"] as const;
export type ContractTab = (typeof CONTRACT_TABS)[number];

export const useContractTab = () => useUrlTab(CONTRACT_TABS);

function Party({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <FieldLabel>{label}</FieldLabel>
      <div className="grid gap-2 border-t border-line-subtle pt-2">{children}</div>
    </div>
  );
}

function ConsumerLine({ c }: { c: ContractConsumerView }) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-13" data-testid="pcc-consumer">
      <b className="font-semibold">{c.project.slug}</b>
      {c.self ? <span className="text-12 text-subtle">this project</span> : null}
      <span className="font-mono text-12-5 text-muted">on {c.builtAgainst}</span>
      <StatusBadge family="contractAdoption" value={c.adoption} />
    </div>
  );
}

function Overview({ d }: { d: ContractStandingDetail }) {
  const c = d.contract;
  return (
    <div className="grid gap-8" data-testid="view-overview">
      {c.summary ? <p className="max-w-[80ch] text-15 leading-relaxed text-fg">{c.summary}</p> : null}
      <section>
        <ViewHeading>Provider, contract and consumers</ViewHeading>
        <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)_auto_minmax(0,1.3fr)] items-start gap-x-4 max-md:grid-cols-1 max-md:gap-y-4" data-testid="pcc">
          <Party label="Provider">
            <div className="text-13">
              <b className="font-semibold">{c.provider.slug}</b>
              {c.direction === "provided" ? <span className="ml-2 text-12 text-subtle">this project</span> : c.provider.name !== c.provider.slug ? <span className="ml-2 text-12 text-subtle">{c.provider.name}</span> : null}
            </div>
          </Party>
          <span aria-hidden className="pt-8 text-muted max-md:hidden">→</span>
          <Party label="Contract">
            <div className="grid gap-1 text-13">
              <span className="font-mono font-semibold">{c.slug}</span>
              <span className="font-mono text-12-5 text-muted">
                {c.current?.version ?? "no version"}
                {c.pending ? ` → ${c.pending.version} proposed` : ""}
              </span>
              <span>
                <ContractStateBadge row={c} />
              </span>
            </div>
          </Party>
          <span aria-hidden className="pt-8 text-muted max-md:hidden">→</span>
          <Party label="Consumers">
            {d.consumers.length === 0 ? <span className="text-13 text-subtle">No consumer in a shared ecosystem.</span> : d.consumers.map((x) => <ConsumerLine key={x.project.id} c={x} />)}
          </Party>
        </div>
      </section>
      <section>
        <ViewHeading right={<span className="text-12 text-subtle">{d.versions.length} recorded</span>}>Versions</ViewHeading>
        <VersionTimeline row={c} versions={d.versions} />
      </section>
    </div>
  );
}

const VERSION_COLS = "grid grid-cols-[110px_120px_minmax(0,1fr)_150px] gap-x-3.5 px-3 max-md:grid-cols-[90px_minmax(0,1fr)]";

function Decide({ d, v, projectId }: { d: ContractStandingDetail; v: ContractVersionView; projectId: string }) {
  const m = useDecideVersion(projectId, d.contract.slug);
  const [returning, setReturning] = useState(false);
  const [reason, setReason] = useState("");
  return (
    <div className="col-span-full grid gap-2 pb-3 pt-1" data-testid="decide-version">
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="primary" size="sm" disabled={m.isPending} onClick={() => m.mutate({ version: v.version, decision: "approve" })} data-testid="approve-version">
          Approve {v.version}
        </Button>
        <Button type="button" variant="secondary" size="sm" disabled={m.isPending} onClick={() => setReturning((r) => !r)}>
          Return
        </Button>
        {v.classification === "breaking" ? (
          <span className="text-12 text-muted">Approving files an item for each consumer, due at the end of the commitment window.</span>
        ) : null}
      </div>
      {returning ? (
        <div className="grid max-w-[560px] gap-2">
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why it goes back: what the provider should change" rows={3} />
          <div>
            <Button type="button" size="sm" disabled={m.isPending || reason.trim().length === 0} onClick={() => m.mutate({ version: v.version, decision: "return", reason: reason.trim() })}>
              Return {v.version}
            </Button>
          </div>
        </div>
      ) : null}
      {m.isError ? <p className="text-12-5 text-danger">{formatApiError(m.error)}</p> : null}
    </div>
  );
}

function Versions({ d, projectId }: { d: ContractStandingDetail; projectId: string }) {
  const c = d.contract;
  const decidable = c.attentionGroup === "needs_you" && c.waitingOn.kind === "you" && c.pending?.version === c.waitingOn.ref;
  return (
    <div data-testid="view-versions">
      <ViewHeading right={<span className="text-12 text-subtle">{c.direction === "consumed" ? "Approved versions only" : "Every recorded version"}</span>}>Version history</ViewHeading>
      {d.versions.length === 0 ? (
        <p className="text-13 text-subtle">No version has been recorded.</p>
      ) : (
        <>
          <div className={`${VERSION_COLS} h-8 items-center border-y border-line-subtle bg-sunken text-11-5 font-semibold text-subtle`} aria-hidden>
            <span>Version</span>
            <span className="max-md:hidden">Recorded</span>
            <span>Changes</span>
            <span className="max-md:hidden">Approval</span>
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
                    {v.previous ? <span className="text-12 text-subtle">after {v.previous}</span> : null}
                  </span>
                  {v.changes.length > 0 ? (
                    <details className="mt-1">
                      <summary className="cursor-pointer select-none text-12-5 font-medium text-muted hover:text-fg">
                        {v.changes.length} {v.changes.length === 1 ? "change" : "changes"}
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
                <span className="max-md:hidden" title={v.decisionReason ?? (v.decidedAt ? `Decided ${formatStamp(v.decidedAt)}` : undefined)}>
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

function Adoption({ d, slug }: { d: ContractStandingDetail; slug: string }) {
  const c = d.contract;
  return (
    <div className="grid gap-8" data-testid="view-adoption">
      <section>
        <ViewHeading right={<AdoptionStrip consumers={d.consumers} latest={c.current?.version ?? null} />}>Who is on which version</ViewHeading>
        {d.consumers.length === 0 ? (
          <p className="text-13 text-subtle">No consumer in a shared ecosystem.</p>
        ) : (
          <ul className="border-t border-line-subtle">
            {d.consumers.map((x) => (
              <li key={x.project.id} className="grid grid-cols-[minmax(0,1fr)_120px_140px] items-center gap-x-3 border-b border-line-subtle px-3 py-2.5 text-13" data-testid="adoption-row">
                <span className="min-w-0 truncate">
                  <b className="font-semibold">{x.project.slug}</b>
                  {x.self ? <span className="ml-2 text-12 text-subtle">this project</span> : null}
                </span>
                <span className="font-mono text-12-5">{x.builtAgainst}</span>
                <StatusBadge family="contractAdoption" value={x.adoption} />
              </li>
            ))}
          </ul>
        )}
      </section>
      <section>
        <ViewHeading>Requests</ViewHeading>
        {d.requests.length === 0 ? (
          <p className="text-13 text-subtle">No change request names this contract.</p>
        ) : (
          <ul className="border-t border-line-subtle">
            {d.requests.map((r) => (
              <li key={r.number} className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line-subtle px-3 py-2.5 text-13" data-testid="request-row">
                <span className="font-mono text-11-5 font-semibold text-subtle">{r.direction === "incoming" ? "In" : "Out"}</span>
                <span className="min-w-0 flex-1">
                  {r.direction === "incoming" ? (
                    <>
                      <b className="font-semibold">{r.counterpart.slug}</b> asks: {r.requirement.title}
                    </>
                  ) : (
                    <>
                      To <b className="font-semibold">{r.counterpart.slug}</b>: {r.requirement.title}
                    </>
                  )}
                </span>
                {r.direction === "incoming" && r.open && c.waitingOn.ref !== r.requirement.key ? (
                  <Link href={requirementHref(slug, r.requirement.key)} className="text-12-5 font-medium text-link hover:underline" data-testid="request-reply">
                    Reply on {r.requirement.key}
                  </Link>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function Measurements({ d }: { d: ContractStandingDetail }) {
  const rows = d.measurements ?? [];
  return (
    <div data-testid="view-measurements">
      <ViewHeading right={<span className="text-12 text-subtle">Measured on each deployed branch</span>}>Measurements</ViewHeading>
      {rows.length === 0 ? (
        <p className="text-13 text-subtle">Nothing has been measured on a deployed branch yet.</p>
      ) : (
        <ul className="border-t border-line-subtle">
          {rows.map((m) => (
            <li key={`${m.observedAt}${m.commit}`} className="grid grid-cols-[120px_90px_minmax(0,1fr)_110px] items-baseline gap-x-3 border-b border-line-subtle px-3 py-2.5 text-13" data-testid="measurement-row">
              <StatusBadge family="measurement" value={m.outcome} />
              <span className="font-mono text-12-5">{m.version ?? "—"}</span>
              <span className="min-w-0 truncate text-12-5 text-muted" title={m.reason ?? `${m.branch} @ ${m.commit}`}>
                {m.environments.join(", ") || "No environment"} · <span className="font-mono">{m.branch}</span>
              </span>
              <span className="text-12 text-subtle" title={formatStamp(m.observedAt)}>
                {m.observedAt.slice(0, 10)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function ContractPage({ d, slug, projectId, tab, onTab }: { d: ContractStandingDetail; slug: string; projectId: string; tab: ContractTab; onTab: (t: ContractTab) => void }) {
  const c = d.contract;
  const tabs = [
    { value: "overview" as const, label: "Overview" },
    { value: "versions" as const, label: "Versions", count: d.versions.length },
    { value: "adoption" as const, label: "Adoption", count: d.consumers.length },
    ...(d.measurements ? [{ value: "measurements" as const, label: "Measurements", count: d.measurements.length }] : []),
  ];
  const shown = tabs.some((t) => t.value === tab) ? tab : "overview";
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
      <DetailMobileTitle itemKey={c.ref} title={c.title} badge={<ContractStateBadge row={c} />} />
      <ContractBanner row={c} slug={slug} className="px-8 py-2.5 max-md:px-4" />
      <DetailTabs tabs={tabs} value={shown} onChange={onTab} testId="contract-tabs" />
      <DetailPane label={tabs.find((t) => t.value === shown)?.label ?? "Overview"}>
        {shown === "overview" ? <Overview d={d} /> : null}
        {shown === "versions" ? <Versions d={d} projectId={projectId} /> : null}
        {shown === "adoption" ? <Adoption d={d} slug={slug} /> : null}
        {shown === "measurements" ? <Measurements d={d} /> : null}
      </DetailPane>
    </DetailLayout>
  );
}

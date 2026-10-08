"use client";
import { EnumBadge, Fact, FactsEmpty, FactsGroup, NotAvailable } from "@/design";
import { FeedbackRailItem } from "@/features/feedback/components/feedback-rail-item";
import { useCopy } from "@/lib/i18n/interface-language";
import { formatStamp } from "@/lib/utils/format";
import type { ContractStandingDetail } from "../types";
import { WindowText } from "./contract-bits";

export function ContractFacts({ d, slug }: { d: ContractStandingDetail; slug: string }) {
  const t = useCopy();
  const c = d.contract;
  return (
    <div data-testid="contract-facts">
      {c.direction === "consumed" ? (
        <FactsGroup title={t("contracts.facts.feedback")} count={d.feedback.length ? t("contracts.facts.items", { n: d.feedback.length }) : undefined} testId="facts-feedback">
          {d.feedback.length === 0 ? (
            <FactsEmpty>{t("contracts.facts.noBreaking")}</FactsEmpty>
          ) : (
            <ul className="grid gap-1">
              {d.feedback.map((f) => (
                <FeedbackRailItem
                  key={f.key}
                  slug={slug}
                  itemKey={f.key}
                  title={f.title}
                  phase={f.status}
                  hint={f.dueAt ? `${f.title} · ${t("contracts.facts.adaptBy", { when: formatStamp(f.dueAt) })}` : undefined}
                />
              ))}
            </ul>
          )}
        </FactsGroup>
      ) : null}

      <FactsGroup title={t("contracts.facts.properties")} testId="facts-properties">
        <Fact label={t("contracts.facts.kind")}>
          <EnumBadge family="interfaceType" value={c.kind} />
        </Fact>
        <Fact label={t("contracts.facts.direction")}>{c.direction === "consumed" ? <span>{t("contracts.from", { project: c.provider.slug })}</span> : <span>{t("contracts.providedBy", { project: c.provider.slug })}</span>}</Fact>
        <Fact label={t("contracts.facts.version")}>
          <span className="font-mono text-12-5" title={c.current ? t("contracts.facts.currentRecorded", { v: c.current.version, when: formatStamp(c.current.recordedAt) }) : t("contracts.facts.noApproved")}>
            {c.direction === "consumed" ? t("contracts.facts.weUse", { v: c.ours ?? t("contracts.facts.noneWord") }) : (c.current?.version ?? t("contracts.facts.noneApproved"))}
          </span>
        </Fact>
        <Fact label={t("contracts.facts.window")}>
          <WindowText row={c} />
        </Fact>
        <Fact label={t("contracts.facts.lifecycle")}>
          <EnumBadge family="lifecycle" value={c.lifecycle} />
        </Fact>
        <Fact label={t("contracts.facts.module")}>
          <NotAvailable reason={d.module.reason} />
        </Fact>
      </FactsGroup>
    </div>
  );
}

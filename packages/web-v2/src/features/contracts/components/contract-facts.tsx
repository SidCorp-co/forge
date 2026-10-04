"use client";
import { EnumBadge, Fact, FactsEmpty, FactsGroup, NotAvailable, } from "@/design";
import { FeedbackRailItem } from "@/features/feedback/components/feedback-rail-item";
import { formatStamp } from "@/lib/utils/format";
import type { ContractStandingDetail } from "../types";
import { KindBadge, WindowText } from "./contract-bits";

export function ContractFacts({ d, slug }: { d: ContractStandingDetail; slug: string }) {
  const c = d.contract;
  return (
    <div data-testid="contract-facts">
      {c.direction === "consumed" ? (
        <FactsGroup title="Feedback" count={d.feedback.length ? `Items ${d.feedback.length}` : undefined} testId="facts-feedback">
          {d.feedback.length === 0 ? (
            <FactsEmpty>No breaking version has been announced to this project.</FactsEmpty>
          ) : (
            <ul className="grid gap-1">
              {d.feedback.map((f) => (
                <FeedbackRailItem
                  key={f.key}
                  slug={slug}
                  itemKey={f.key}
                  title={f.title}
                  phase={f.status}
                  hint={f.dueAt ? `${f.title} · adapt by ${formatStamp(f.dueAt)}` : undefined}
                />
              ))}
            </ul>
          )}
        </FactsGroup>
      ) : null}

      <FactsGroup title="Properties" testId="facts-properties">
        <Fact label="Kind">
          <KindBadge kind={c.kind} />
        </Fact>
        <Fact label="Direction">{c.direction === "consumed" ? <span>From {c.provider.slug}</span> : <span>Provided by {c.provider.slug}</span>}</Fact>
        <Fact label="Version">
          <span className="font-mono text-12-5" title={c.current ? `Current ${c.current.version} · recorded ${formatStamp(c.current.recordedAt)}` : "No approved version"}>
            {c.direction === "consumed" ? `We use ${c.ours ?? "none"}` : (c.current?.version ?? "None approved")}
          </span>
        </Fact>
        <Fact label="Window">
          <WindowText row={c} />
        </Fact>
        <Fact label="Lifecycle">
          <EnumBadge family="lifecycle" value={c.lifecycle} />
        </Fact>
        <Fact label="Module">
          <NotAvailable reason={d.module.reason} />
        </Fact>
      </FactsGroup>
    </div>
  );
}

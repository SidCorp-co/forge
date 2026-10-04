"use client";

import Link from "next/link";
import { EnumBadge, Fact, FactsEmpty, FactsGroup, NotAvailable, StatusBadge } from "@/design";
import { ecosystemRoutes } from "@/features/ecosystem/routes";
import { feedbackHref } from "@/features/feedback/routes";
import { issueHref } from "@/features/issues/routes";
import { requirementHref } from "@/features/requirements/routes";
import { formatStamp } from "@/lib/utils/format";
import type { ContractStandingDetail } from "../types";
import { KindBadge, WindowText } from "./contract-bits";

function Waits({ d, slug }: { d: ContractStandingDetail; slug: string }) {
  if (d.contract.direction === "provided") {
    return (
      <FactsGroup title="Issues waiting in other projects" count={d.demand.length ? `Projects ${d.demand.length}` : undefined} testId="facts-demand">
        {d.demand.length === 0 ? (
          <FactsEmpty>No consumer has an issue waiting on a version.</FactsEmpty>
        ) : (
          <ul className="grid gap-1">
            {d.demand.map((x) => (
              <li key={x.project.id} className="flex min-w-0 items-center gap-1.5 text-13" data-testid="rail-demand" title="A consumer's issues are its own record: counted here, never named">
                <span className="font-semibold">{x.project.slug}</span>
                <span className="text-muted">
                  {x.issues} {x.issues === 1 ? "issue needs" : "issues need"} ≥ {x.minVersions.join(", ")}
                </span>
              </li>
            ))}
          </ul>
        )}
      </FactsGroup>
    );
  }
  const open = d.waits.filter((w) => !w.settled);
  return (
    <FactsGroup title={`Issues in ${d.project.slug} waiting on a version`} count={open.length ? `Waiting ${open.length}` : undefined} testId="facts-waits">
      {d.waits.length === 0 ? (
        <FactsEmpty>None.</FactsEmpty>
      ) : (
        <ul className="grid gap-1">
          {d.waits.map((w) => (
            <li key={w.issue} className="flex min-w-0 items-center gap-1.5 text-13" data-testid="rail-wait">
              <Link href={issueHref(slug, w.issue)} className="flex-none font-mono text-12 font-semibold text-link hover:underline">
                {w.issue}
              </Link>
              <span className="min-w-0 flex-1 truncate" title={w.reason ? `${w.title} · ${w.reason}` : w.title}>
                {w.title}
              </span>
              <span className="flex-none font-mono text-11-5 text-subtle" title={w.settled ? "Settled: the provider approved a version at or above it" : "Unsettled: holds the issue out of dispatch"}>
                {w.settled ? "settled" : `≥ ${w.minVersion}`}
              </span>
            </li>
          ))}
        </ul>
      )}
    </FactsGroup>
  );
}

export function ContractFacts({ d, slug }: { d: ContractStandingDetail; slug: string }) {
  const c = d.contract;
  return (
    <div data-testid="contract-facts">
      <Waits d={d} slug={slug} />

      {c.direction === "consumed" ? (
        <FactsGroup title="Feedback" count={d.feedback.length ? `Items ${d.feedback.length}` : undefined} testId="facts-feedback">
          {d.feedback.length === 0 ? (
            <FactsEmpty>No breaking version has been announced to this project.</FactsEmpty>
          ) : (
            <ul className="grid gap-1">
              {d.feedback.map((f) => (
                <li key={f.key} className="flex min-w-0 items-center gap-1.5 text-13" data-testid="rail-feedback">
                  <Link href={feedbackHref(slug, f.key)} className="flex-none font-mono text-12 font-semibold text-link hover:underline">
                    {f.key}
                  </Link>
                  <span className="min-w-0 flex-1 truncate" title={f.dueAt ? `${f.title} · adapt by ${formatStamp(f.dueAt)}` : f.title}>
                    {f.title}
                  </span>
                  <StatusBadge family="feedbackPhase" value={f.status} />
                </li>
              ))}
            </ul>
          )}
        </FactsGroup>
      ) : null}

      <FactsGroup title="Requirement" testId="facts-requirement">
        {d.requests.length === 0 ? (
          <FactsEmpty>No change request names it.</FactsEmpty>
        ) : (
          <ul className="grid gap-1">
            {d.requests.map((r) => (
              <li key={r.number} className="flex min-w-0 items-center gap-1.5 text-13" data-testid="rail-requirement">
                {r.direction === "incoming" ? (
                  <Link href={requirementHref(slug, r.requirement.key)} className="flex-none font-mono text-12 font-semibold text-link hover:underline">
                    {r.requirement.key}
                  </Link>
                ) : (
                  <span className="flex-none font-mono text-12 font-semibold" title={`${r.requirement.project}'s requirement`}>
                    {r.requirement.project} {r.requirement.key}
                  </span>
                )}
                <span className="min-w-0 flex-1 truncate" title={r.requirement.title}>
                  {r.requirement.title}
                </span>
                <StatusBadge family="requirement" value={r.requirement.status} />
              </li>
            ))}
          </ul>
        )}
      </FactsGroup>

      <FactsGroup title="Ecosystem thread" testId="facts-thread">
        {d.requests.length === 0 ? (
          <FactsEmpty>No thread is open on it.</FactsEmpty>
        ) : (
          <ul className="grid gap-1">
            {d.requests.map((r) => (
              <li key={r.number} className="flex min-w-0 items-center gap-1.5 text-13">
                <Link href={ecosystemRoutes.document(slug, r.number)} className="font-mono text-12 font-semibold text-link hover:underline">
                  {r.number}
                </Link>
                <span className="text-muted">{r.direction === "incoming" ? `from ${r.counterpart.slug}` : `to ${r.counterpart.slug}`}</span>
              </li>
            ))}
          </ul>
        )}
      </FactsGroup>

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

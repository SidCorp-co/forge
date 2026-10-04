"use client";

import type { ReactNode } from "react";
import { HoverCard, LEGEND, Tooltip } from "@/design";
import { formatCountdown, formatStamp } from "@/lib/utils/format";
import type { DevelopmentOverview } from "../types";

function Signal({ label, children, testId }: { label: string; children: ReactNode; testId: string }) {
  return (
    <div className="flex min-w-0 items-baseline gap-2" data-testid={testId}>
      <dt className="whitespace-nowrap text-12-5 font-medium text-muted">{label}</dt>
      <dd className="min-w-0 text-12-5 text-fg">{children}</dd>
    </div>
  );
}

export function Unavailable({ reason }: { reason: string }) {
  return (
    <Tooltip label={reason} multiline>
      <span className="cursor-help text-muted underline decoration-dotted underline-offset-2" data-testid="signal-unavailable">
        Not available
      </span>
    </Tooltip>
  );
}

function Contracts({ s }: { s: DevelopmentOverview["signals"]["contracts"] }) {
  const next = s.windows[0];
  if (s.openWindows === 0 && s.awaitingApproval === 0) return <span className="text-muted">No window open</span>;
  return (
    <span className="inline-flex flex-wrap items-baseline gap-x-3">
      {s.openWindows > 0 && next ? (
        <HoverCard
          label="Contract windows"
          content={
            <ul className="grid gap-1.5 text-12-5">
              {s.windows.map((w) => (
                <li key={`${w.contract}@${w.version}`}>
                  <span className="font-mono text-12 font-semibold">
                    {w.contract} {w.version}
                  </span>{" "}
                  <span className="text-muted">
                    adapt by {formatStamp(w.dueAt)} · {w.feedback}
                  </span>
                </li>
              ))}
              {s.openWindows > s.windows.length ? <li className="text-muted">and {s.openWindows - s.windows.length} more</li> : null}
            </ul>
          }
        >
          <span>
            Windows open <b className="font-semibold">{s.openWindows}</b>
            <span className="text-muted">
              {" "}
              · next {next.contract} {next.version} {formatCountdown(next.dueAt)}
            </span>
          </span>
        </HoverCard>
      ) : null}
      {s.awaitingApproval > 0 ? (
        <span style={{ color: LEGEND.you.fg }}>
          To approve <b className="font-semibold">{s.awaitingApproval}</b>
        </span>
      ) : null}
    </span>
  );
}

function Master({ s }: { s: DevelopmentOverview["signals"]["master"] }) {
  return (
    <span className="inline-flex flex-wrap items-baseline gap-x-3">
      <span>
        Slots in use <b className="font-semibold">{s.runs}</b>
        {s.capacity === null ? (
          <Tooltip label={s.capacityNote} multiline>
            <span className="ml-1 cursor-help text-muted underline decoration-dotted underline-offset-2" data-testid="capacity-unavailable">
              of ?
            </span>
          </Tooltip>
        ) : (
          <span className="text-muted"> of {s.capacity}</span>
        )}
      </span>
      <span className={s.masters === 0 ? "text-muted" : undefined}>
        Masters live <b className="font-semibold">{s.masters}</b>
      </span>
    </span>
  );
}

export function SignalsStrip({ data }: { data: DevelopmentOverview }) {
  return (
    <div className="border-b border-line-subtle bg-surface" data-testid="signals-strip">
      <dl className="flex flex-wrap items-baseline gap-x-8 gap-y-2 px-5 py-2.5 max-md:px-3" aria-label="Signals">
        <Signal label="CI on dev" testId="signal-ci">
          <Unavailable reason={data.signals.ci.reason} />
        </Signal>
        <Signal label="Post-merge" testId="signal-post-merge">
          <Unavailable reason={data.signals.postMerge.reason} />
        </Signal>
        <Signal label="Contracts" testId="signal-contracts">
          <Contracts s={data.signals.contracts} />
        </Signal>
        <Signal label="Master" testId="signal-master">
          <Master s={data.signals.master} />
        </Signal>
      </dl>
    </div>
  );
}

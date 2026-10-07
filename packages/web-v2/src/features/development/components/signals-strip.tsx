"use client";

import type { Said } from "@forge/contracts/said";
import type { ReactNode } from "react";
import { HoverCard, LEGEND, Tooltip } from "@/design";
import { useCopy, useInterfaceLanguage, useTimeFormat } from "@/lib/i18n/interface-language";
import { said } from "@/lib/i18n/said";
import type { DevelopmentOverview } from "../types";

function Signal({ label, children, testId }: { label: string; children: ReactNode; testId: string }) {
  return (
    <div className="flex min-w-0 items-baseline gap-2" data-testid={testId}>
      <dt className="whitespace-nowrap text-12-5 font-medium text-muted">{label}</dt>
      <dd className="min-w-0 text-12-5 text-fg">{children}</dd>
    </div>
  );
}

/** A signal core cannot read, its reason read from what core said (`development/overview-read.ts`). */
export function Unavailable({ reason }: { reason: Said }) {
  const t = useCopy();
  const language = useInterfaceLanguage();
  return (
    <Tooltip label={said(reason, language)} multiline>
      <span className="cursor-help text-muted underline decoration-dotted underline-offset-2" data-testid="signal-unavailable">
        {t("overview.signal.unavailable")}
      </span>
    </Tooltip>
  );
}

function Contracts({ s }: { s: DevelopmentOverview["signals"]["contracts"] }) {
  const next = s.windows[0];
  const t = useCopy();
  const time = useTimeFormat();
  if (s.openWindows === 0 && s.awaitingApproval === 0) return <span className="text-muted">{t("overview.signal.noWindow")}</span>;
  return (
    <span className="inline-flex flex-wrap items-baseline gap-x-3">
      {s.openWindows > 0 && next ? (
        <HoverCard
          label={t("overview.signal.windows")}
          content={
            <ul className="grid gap-1.5 text-12-5">
              {s.windows.map((w) => (
                <li key={`${w.contract}@${w.version}`}>
                  <span className="font-mono text-12 font-semibold">
                    {w.contract} {w.version}
                  </span>{" "}
                  <span className="text-muted">
                    {t("overview.signal.adaptBy", { at: time.dateTime(w.dueAt) })} · {w.feedback}
                  </span>
                </li>
              ))}
              {s.openWindows > s.windows.length ? <li className="text-muted">{t("overview.signal.andMore", { n: s.openWindows - s.windows.length })}</li> : null}
            </ul>
          }
        >
          <span>
            {t("overview.signal.windowsOpen")} <b className="font-semibold">{s.openWindows}</b>
            <span className="text-muted">
              {" "}
              · {t("overview.signal.next", { contract: next.contract, version: next.version, when: time.countdown(next.dueAt) })}
            </span>
          </span>
        </HoverCard>
      ) : null}
      {s.awaitingApproval > 0 ? (
        <span style={{ color: LEGEND.you.fg }}>
          {t("overview.signal.toApprove")} <b className="font-semibold">{s.awaitingApproval}</b>
        </span>
      ) : null}
    </span>
  );
}

function Master({ s }: { s: DevelopmentOverview["signals"]["master"] }) {
  const max = s.slots?.max ?? null;
  const t = useCopy();
  const language = useInterfaceLanguage();
  return (
    <span className="inline-flex flex-wrap items-baseline gap-x-3">
      <span>
        {t("overview.signal.slotsInUse")} <b className="font-semibold">{s.slots ? s.slots.inUse : "?"}</b>
        {max === null ? (
          <Tooltip label={said(s.says.slotsNote, language)} multiline>
            <span className="ml-1 cursor-help text-muted underline decoration-dotted underline-offset-2" data-testid="capacity-unavailable">
              {t("overview.signal.of", { max: "?" })}
            </span>
          </Tooltip>
        ) : (
          <span className="text-muted"> {t("overview.signal.of", { max })}</span>
        )}
      </span>
      <span className={s.masters === 0 ? "text-muted" : undefined}>
        {t("overview.signal.mastersLive")} <b className="font-semibold">{s.masters}</b>
      </span>
    </span>
  );
}

export function SignalsStrip({ data }: { data: DevelopmentOverview }) {
  const t = useCopy();
  return (
    <div className="border-b border-line-subtle bg-surface" data-testid="signals-strip">
      <dl className="flex flex-wrap items-baseline gap-x-8 gap-y-2 px-5 py-2.5 max-md:px-3" aria-label={t("overview.signal.signals")}>
        <Signal label={t("overview.signal.ci")} testId="signal-ci">
          <Unavailable reason={data.signals.ci.says.reason} />
        </Signal>
        <Signal label={t("overview.signal.postMerge")} testId="signal-post-merge">
          <Unavailable reason={data.signals.postMerge.says.reason} />
        </Signal>
        <Signal label={t("overview.signal.contracts")} testId="signal-contracts">
          <Contracts s={data.signals.contracts} />
        </Signal>
        <Signal label={t("overview.signal.master")} testId="signal-master">
          <Master s={data.signals.master} />
        </Signal>
      </dl>
    </div>
  );
}

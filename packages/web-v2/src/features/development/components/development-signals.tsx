"use client";

import type { Said } from "@forge/contracts/said";
import { HoverCard, Signal, SignalsStrip, Tooltip } from "@/design";
import { useCopy, useInterfaceLanguage, useTimeFormat } from "@/lib/i18n/interface-language";
import { said } from "@/lib/i18n/said";
import type { DevelopmentOverview } from "../types";

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
            <ul className="grid gap-1.5 text-13">
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
        <span className="text-status-warn-fg">
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

/** The development overview's signals: CI, post-merge, the contracts window and the master, on the shared strip. */
export function DevelopmentSignals({ data }: { data: DevelopmentOverview }) {
  const t = useCopy();
  return (
    <SignalsStrip>
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
    </SignalsStrip>
  );
}

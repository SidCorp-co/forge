// A part of the status report (ISS-903 face): one line shut, its title, how many it holds and a few
// words, the moment its own read answered on that line's hover; the lead parts (what is stuck, what
// needs you) stand open. Every part prints open, so a printed report is the whole report.

import type { ReactNode } from "react";
import { Disclosure } from "@/design";
import { type EtaClock } from "@/features/forecast";
import { formatDateTime } from "@/lib/i18n/format";
import { useCopy } from "@/lib/i18n/interface-language";

interface ReportPartProps {
  title: string;
  asOf: string;
  clock: EtaClock;
  testId: string;
  /** How many it holds, where it holds a list. */
  count?: number;
  /** A few words beside the count, read while it is shut. */
  note?: string;
  /** A lead part stands open. */
  lead?: boolean;
  children: ReactNode;
}

export function ReportPart({ title, asOf, clock, testId, count, note, lead = false, children }: ReportPartProps) {
  const t = useCopy();
  return (
    <section aria-label={title} data-testid={testId} className="break-inside-avoid">
      <Disclosure
        title={title}
        count={count}
        summary={note}
        hint={t("status.readAt", { at: formatDateTime(asOf, clock.lang, clock.timeZone) })}
        defaultOpen={lead}
        printsOpen
        testId={`${testId}-fold`}
      >
        {children}
      </Disclosure>
    </section>
  );
}

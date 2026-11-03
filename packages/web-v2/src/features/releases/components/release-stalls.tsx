// What stalled delivery of a release's issues (REQ-67 BC-7): one line counting each cause, each count
// opening the stalls behind it — the item or issue each stood on and the question it raised. A release
// with none says so in two words. A shared page carries no stalls and draws nothing here.

import { useState } from "react";
import type { ReleasePage } from "@forge/contracts/release-page";
import { STALL_CAUSES, type StallCause } from "@forge/contracts/stalls";
import { useCopy } from "@/lib/i18n/interface-language";
import { DisclosureToggle } from "./release-bits";

export function ReleaseStalls({ page }: { page: ReleasePage }) {
  const t = useCopy();
  const [open, setOpen] = useState<StallCause | null>(null);
  const stalls = page.stalls;
  if (!stalls) return null;
  const counted = STALL_CAUSES.filter((c) => stalls.counts[c] > 0);
  if (counted.length === 0)
    return (
      <p className="border-t border-line-subtle pt-3 text-14 text-muted" data-testid="page-stalls-none">
        {t("releases.page.stalls.none")}
      </p>
    );
  const shown = open ? stalls.stalls.filter((s) => s.cause === open) : [];
  return (
    <div className="grid gap-2 border-t border-line-subtle pt-3" data-testid="page-stalls">
      <p className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-14 text-muted">
        <span className="font-medium text-fg">{t("releases.page.stalls.title")}</span>
        {counted.map((c) => (
          <DisclosureToggle key={c} open={open === c} onToggle={() => setOpen((o) => (o === c ? null : c))} className="text-14" testId={`page-stalls-${c}`}>
            {t(`releases.page.stalls.cause.${c}`, { n: stalls.counts[c] })}
          </DisclosureToggle>
        ))}
      </p>
      {open ? (
        <ul className="grid gap-1 text-14" data-testid="page-stalls-list">
          {shown.map((s) => (
            <li key={`${s.startedAt}:${s.issue?.key ?? ""}:${s.item?.key ?? ""}:${s.question ?? ""}`} className="grid" data-testid="page-stall">
              <span className="text-fg">
                {s.item?.title ?? s.issue?.title}
                {s.endedAt === null ? <span className="ml-2 text-12 text-subtle">{t("releases.page.stalls.open")}</span> : null}
              </span>
              {s.question ? <span className="text-muted">{s.question}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

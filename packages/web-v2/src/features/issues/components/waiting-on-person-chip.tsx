"use client";

import { MonoTag } from "@/design";
import { useCopy, useTimeFormat } from "@/lib/i18n/interface-language";

/** ISS-1257 — the issue list is the queue of what a person owes an answer to, so the row says so. */
export function WaitingOnPersonChip({
  since,
  now,
}: {
  since: string | null | undefined;
  /** The list's one instant, so two rows' ages are a comparison. */
  now: number;
}) {
  const t = useCopy();
  const time = useTimeFormat();
  if (!since) return null;
  const at = new Date(since).getTime();
  if (Number.isNaN(at)) return null;
  const age = time.elapsed(now - at);
  return (
    <span
      title={t("issues.waitingOnPerson.hint", { age })}
      data-testid="waiting-on-person"
    >
      <MonoTag hue="flame">{t("issues.waitingOnPerson.chip", { age })}</MonoTag>
    </span>
  );
}

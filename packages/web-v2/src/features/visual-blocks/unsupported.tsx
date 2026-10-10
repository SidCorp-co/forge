"use client";

import { useCopy } from "@/lib/i18n/interface-language";

/** A block this screen cannot draw, named. It is never left out: a vanished block reads as an answer that was never given. */
export function UnsupportedBlock({ kind, reason }: { kind: string; reason?: string }) {
  const t = useCopy();
  return (
    <p className="text-13 text-muted" data-testid="visual-block-unsupported" data-kind={kind}>
      {reason === undefined ? t("visual.unsupported", { kind }) : t("visual.unsupported.because", { kind, reason })}
    </p>
  );
}

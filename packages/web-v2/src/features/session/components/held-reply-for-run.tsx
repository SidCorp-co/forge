"use client";

import { MonoTag, PageSectionTitle } from "@/design";
import { useCopy } from "@/lib/i18n/interface-language";
import type { SessionMetadata } from "@/features/sessions/types";

interface HeldRefusal {
  rule: string;
  why: string;
  quote: string | null;
}

/** The rules the reply check held this session's conversation reply on, as core stamped them on its marker. */
export function heldRefusalsOf(metadata: SessionMetadata | null): HeldRefusal[] {
  const held = (metadata?.conversationAgent as { held?: { refusals?: unknown } } | undefined)?.held;
  if (!held || !Array.isArray(held.refusals)) return [];
  return held.refusals.filter(
    (r): r is HeldRefusal => !!r && typeof r.rule === "string" && typeof r.why === "string",
  );
}

export function HeldReplyForRun({ metadata }: { metadata: SessionMetadata | null }) {
  const t = useCopy();
  const refusals = heldRefusalsOf(metadata);
  if (refusals.length === 0) return null;
  return (
    <section data-testid="session-held-reply">
      <PageSectionTitle className="fg-caption sticky top-0 z-10 mb-2 bg-app py-1 uppercase tracking-wide">
        {t("sessions.held.title")}
      </PageSectionTitle>
      <p className="fg-body-sm mb-2">{t("sessions.held.lead")}</p>
      <ul className="flex flex-col gap-2">
        {refusals.map((r) => (
          <li key={`${r.rule}:${r.why}`} className="flex flex-col gap-0.5">
            <MonoTag hue="flame">{r.rule}</MonoTag>
            <span className="fg-caption">{r.why}</span>
            {r.quote && <span className="fg-caption text-subtle">“{r.quote}”</span>}
          </li>
        ))}
      </ul>
    </section>
  );
}

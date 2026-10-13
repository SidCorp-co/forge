
import { MonoTag, FactsGroup } from "@/design";
import { useCopy } from "@/lib/i18n/interface-language";
import type { SessionMetadata } from "@/features/sessions";

interface HeldRefusal {
  rule: string;
  why: string;
  quote: string | null;
  /** The check could not run, and why: a failure on Forge's side, not a rule the reply broke. */
  unchecked?: string;
}

/** The rules the reply check held this session's conversation reply on, as core stamped them on its marker. */
function heldRefusalsOf(metadata: SessionMetadata | null): HeldRefusal[] {
  const held = (metadata?.conversationAgent as { held?: { refusals?: unknown } } | undefined)?.held;
  if (!held || !Array.isArray(held.refusals)) return [];
  return (held.refusals as unknown[]).filter((r): r is HeldRefusal => {
    if (!r || typeof r !== "object") return false;
    const o = r as Record<string, unknown>;
    return typeof o.rule === "string" && typeof o.why === "string";
  });
}

export function HeldReplyForRun({ metadata }: { metadata: SessionMetadata | null }) {
  const t = useCopy();
  const refusals = heldRefusalsOf(metadata);
  if (refusals.length === 0) return null;
  return (
    <FactsGroup title={t("sessions.held.title")} testId="session-held-reply">
      <p className="fg-body-sm mb-2">{t("sessions.held.lead")}</p>
      <ul className="flex flex-col gap-2">
        {refusals.map((r) => (
          <li key={`${r.rule}:${r.why}`} className="flex flex-col gap-0.5">
            <MonoTag hue="flame">{r.rule}</MonoTag>
            <span className="fg-caption">
              {typeof r.unchecked === "string" ? t("sessions.held.couldNotRun", { why: r.unchecked }) : r.why}
            </span>
            {r.quote && <span className="fg-caption text-subtle">“{r.quote}”</span>}
          </li>
        ))}
      </ul>
    </FactsGroup>
  );
}

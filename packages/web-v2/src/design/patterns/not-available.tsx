
import { useCopy } from "@/lib/i18n/interface-language";

const sentence = (t: string) => `${t.charAt(0).toUpperCase()}${t.slice(1)}`;

// a fact no record holds is said as such, never left blank or guessed: "Not available", the reason on hover (or inline with `showReason`)
export function NotAvailable({ reason, showReason = false }: { reason: string; showReason?: boolean }) {
  const t = useCopy();
  return (
    <span className="cursor-help text-subtle underline decoration-dotted underline-offset-2" title={sentence(reason)} data-testid="not-available">
      {t("common.notAvailable")}
      {showReason ? `: ${reason}` : ""}
    </span>
  );
}

import { cn } from "@/lib/utils/cn";
import { Icon, type IconName } from "@/design/icons/icon";

export type ToastTone = "default" | "success" | "error" | "info";

const TONE: Record<ToastTone, { icon?: IconName; color: string }> = {
  default: { color: "var(--fg-muted)" },
  success: { icon: "check", color: "var(--green-500)" },
  error: { icon: "alert", color: "var(--red-500)" },
  info: { icon: "activity", color: "var(--cobalt-500)" },
};

export interface ToastView {
  title: string;
  description?: string;
  tone?: ToastTone;
}

/** Presentational toast card. State/stacking lives in the ToastProvider. */
export function Toast({ title, description, tone = "default", onClose }: ToastView & { onClose?: () => void }) {
  const t = TONE[tone];
  return (
    <div
      className={cn(
        "forge-slide flex w-[320px] items-start gap-2.5 rounded-lg border border-line bg-surface px-4 py-3 shadow-lg",
      )}
      role="status"
    >
      {t.icon && <Icon name={t.icon} size={17} style={{ color: t.color, marginTop: 1 }} />}
      <div className="flex-1">
        <p className="fg-label">{title}</p>
        {description && <p className="fg-caption mt-0.5">{description}</p>}
      </div>
      {onClose && (
        <button type="button" onClick={onClose} aria-label="Dismiss" className="text-subtle hover:text-fg">
          <Icon name="x" size={15} />
        </button>
      )}
    </div>
  );
}

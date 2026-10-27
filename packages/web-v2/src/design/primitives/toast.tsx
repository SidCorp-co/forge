import Link from "next/link";
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
  /** When set, the card body is clickable (e.g. deep-link to an issue). The
   *  dismiss button keeps its own handler and never triggers onClick. */
  onClick?: () => void;
  /** The description's spaces and blank lines are kept as written: text a reader is to select and copy
   *  by hand must be the text itself (ISS-1229 r32). */
  verbatim?: boolean;
  /** A place the toast sends the reader, as a link under its text; following it puts the toast away. */
  link?: { label: string; href: string };
}

/** Presentational toast card. State/stacking lives in the ToastProvider. */
export function Toast({
  title,
  description,
  tone = "default",
  onClick,
  verbatim = false,
  link,
  onClose,
  onHold,
}: ToastView & {
  onClose?: () => void;
  /** Told true while the pointer rests on the card or focus is inside it, and false once neither is. */
  onHold?: (held: boolean) => void;
}) {
  const t = TONE[tone];
  const clickable = typeof onClick === "function";
  return (
    <div
      className={cn(
        "forge-slide flex w-[320px] items-start gap-2.5 rounded-lg border border-line bg-surface px-4 py-3 shadow-lg",
        clickable && "cursor-pointer transition-colors hover:bg-hover",
      )}
      role={clickable ? "button" : "status"}
      tabIndex={clickable ? 0 : undefined}
      onClick={clickable ? onClick : undefined}
      onMouseEnter={() => onHold?.(true)}
      onMouseLeave={(e) => {
        if (!e.currentTarget.contains(document.activeElement)) onHold?.(false);
      }}
      onFocus={() => onHold?.(true)}
      onBlur={(e) => {
        const into = e.relatedTarget;
        if (!(into instanceof Node && e.currentTarget.contains(into)) && !e.currentTarget.matches(":hover"))
          onHold?.(false);
      }}
      onKeyDown={
        clickable
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onClick?.();
              }
            }
          : undefined
      }
    >
      {t.icon && <Icon name={t.icon} size={17} style={{ color: t.color, marginTop: 1 }} />}
      <div className="flex-1">
        <p className="fg-label">{title}</p>
        {description && (
          <p className={cn("fg-caption mt-0.5", verbatim ? "whitespace-pre-wrap" : "whitespace-pre-line")}>
            {description}
          </p>
        )}
        {link && (
          <Link
            href={link.href}
            className="fg-caption mt-1 inline-block text-accent-text underline-offset-2 hover:underline"
            onClick={(e) => {
              e.stopPropagation();
              onClose?.();
            }}
          >
            {link.label}
          </Link>
        )}
      </div>
      {onClose && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
          aria-label="Dismiss"
          className="text-subtle hover:text-fg"
        >
          <Icon name="x" size={15} />
        </button>
      )}
    </div>
  );
}

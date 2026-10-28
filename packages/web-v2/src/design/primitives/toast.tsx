"use client";

import Link from "next/link";
import { useRef } from "react";
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
  /** Told true while a mouse pointer rests on the card or focus is inside it, and false once neither is. */
  onHold?: (held: boolean) => void;
}) {
  const t = TONE[tone];
  const clickable = typeof onClick === "function";
  const resting = useRef(false);
  return (
    <div
      className={cn(
        "forge-slide flex w-[320px] items-start gap-2.5 rounded-lg border border-line bg-surface px-4 py-3 shadow-lg",
        clickable && "cursor-pointer transition-colors hover:bg-hover",
      )}
      role={clickable ? "button" : "status"}
      tabIndex={clickable ? 0 : undefined}
      onClick={clickable ? onClick : undefined}
      // A resting mouse holds it; a finger does not rest, and a tap on a phone left it held over Save for as long
      // as nothing else was tapped (ISS-1229 r53, judge-165).
      onPointerEnter={(e) => {
        if (e.pointerType !== "mouse") return;
        resting.current = true;
        onHold?.(true);
      }}
      onPointerLeave={(e) => {
        if (e.pointerType !== "mouse") return;
        resting.current = false;
        if (!e.currentTarget.contains(document.activeElement)) onHold?.(false);
      }}
      onFocus={() => onHold?.(true)}
      onBlur={(e) => {
        const into = e.relatedTarget;
        if (!(into instanceof Node && e.currentTarget.contains(into)) && !resting.current) onHold?.(false);
      }}
      onKeyDown={
        clickable
          ? (e) => {
              // A control inside the card, its link or Dismiss, keeps its own keys.
              if (e.target !== e.currentTarget) return;
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
            className="mt-1 inline-block text-xs font-medium text-accent hover:underline"
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

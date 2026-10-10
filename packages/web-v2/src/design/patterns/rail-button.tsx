"use client";

// An act at the foot of the navigation rail: an icon and its name, the name under the icon on the
// collapsed rail, and a dot while something there is owed to the reader.

import { cn } from "@/lib/utils/cn";
import { Icon, type IconName } from "../icons/icon";

export function RailButton({
  icon,
  label,
  ariaLabel = label,
  dot = false,
  dotTestId,
  compact = false,
  tour,
  onClick,
}: {
  icon: IconName;
  label: string;
  ariaLabel?: string;
  /** Something there is owed to the reader. */
  dot?: boolean;
  dotTestId?: string;
  /** The collapsed rail: the name under the icon. */
  compact?: boolean;
  /** The `data-tour` anchor a tour step points at. */
  tour?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-tour={tour}
      aria-label={ariaLabel}
      className={cn(
        "relative flex w-full items-center rounded-md py-1.5 text-muted transition-colors hover:bg-hover hover:text-fg max-md:min-h-11",
        compact ? "flex-col gap-0.5 px-1 text-12" : "gap-2.5 px-1.5 text-13",
      )}
    >
      <Icon name={icon} size={compact ? 15 : 16} />
      <span className={cn(!compact && "flex-1 text-left")}>{label}</span>
      {dot ? <span data-testid={dotTestId} aria-hidden className={cn("size-2 rounded-pill bg-accent", compact ? "absolute right-4 top-1" : "flex-none")} /> : null}
    </button>
  );
}

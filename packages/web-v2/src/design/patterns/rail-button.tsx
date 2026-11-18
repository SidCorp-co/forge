
// An act in the phone's navigation drawer: an icon and its name, and a dot while something there is
// owed to the reader. On the desktop rail these acts are rows of the account chip's menu (ISS-1331).

import { Icon, type IconName } from "../icons/icon";

export function RailButton({
  icon,
  label,
  ariaLabel = label,
  dot = false,
  dotTestId,
  tour,
  onClick,
}: {
  icon: IconName;
  label: string;
  ariaLabel?: string;
  /** Something there is owed to the reader. */
  dot?: boolean;
  dotTestId?: string;
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
      className="relative flex w-full items-center gap-2.5 rounded-md px-1.5 py-1.5 text-13 text-muted transition-colors hover:bg-hover hover:text-fg max-md:min-h-11"
    >
      <Icon name={icon} size={16} />
      <span className="flex-1 text-left">{label}</span>
      {dot ? <span data-testid={dotTestId} aria-hidden className="size-2 flex-none rounded-pill bg-accent" /> : null}
    </button>
  );
}

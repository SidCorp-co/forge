import type { ReactNode } from "react";
import { Icon, type IconName } from "@/design/icons/icon";
import { IconButton } from "./icon-button";

type Tone = "info" | "attention" | "danger" | "success";

const TONE: Record<Tone, { fg: string; bg: string; border: string; icon: IconName }> = {
  info: { fg: "var(--cobalt-700)", bg: "var(--cobalt-50)", border: "var(--cobalt-100)", icon: "activity" },
  attention: { fg: "var(--amberw-600)", bg: "var(--amberw-50)", border: "var(--amber-50)", icon: "alert" },
  danger: { fg: "var(--red-600)", bg: "var(--red-50)", border: "var(--red-50)", icon: "alert" },
  success: { fg: "var(--green-600)", bg: "var(--green-50)", border: "var(--green-50)", icon: "check" },
};

export interface BannerProps {
  tone?: Tone;
  children: ReactNode;
  action?: ReactNode;
  onDismiss?: () => void;
}

/** Full-width contextual banner (e.g. needs-attention, live run, error). */
export function Banner({ tone = "info", children, action, onDismiss }: BannerProps) {
  const t = TONE[tone];
  return (
    <div
      className="flex items-center gap-3 rounded-lg border px-4 py-3"
      style={{ color: t.fg, background: t.bg, borderColor: t.border }}
    >
      <Icon name={t.icon} size={18} />
      <div className="fg-body-sm flex-1" style={{ color: t.fg }}>
        {children}
      </div>
      {action}
      {onDismiss && <IconButton icon="x" size="sm" aria-label="Dismiss" onClick={onDismiss} />}
    </div>
  );
}

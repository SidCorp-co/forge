import type { ReactNode } from "react";
import { Icon, type IconName } from "@/design/icons/icon";
import { cn } from "@/lib/utils/cn";
import { IconButton } from "./icon-button";

type Tone = "info" | "attention" | "danger" | "success";

const TONE: Record<Tone, { line: string; text: string; icon: IconName }> = {
  info: { line: "border-info-9", text: "text-info-11", icon: "activity" },
  attention: { line: "border-warn-9", text: "text-warn-11", icon: "alert" },
  danger: { line: "border-danger-9", text: "text-danger-11", icon: "alert" },
  success: { line: "border-ok-9", text: "text-ok-11", icon: "check" },
};

export interface BannerProps {
  tone?: Tone;
  children: ReactNode;
  action?: ReactNode;
  onDismiss?: () => void;
}

/** A notice line in the flow of the page: a tone rule at its left, the tone's icon and text, never a box. */
export function Banner({ tone = "info", children, action, onDismiss }: BannerProps) {
  const t = TONE[tone];
  return (
    <div className={cn("flex items-center gap-2.5 border-l-2 py-1 pl-3", t.line)}>
      <Icon name={t.icon} size={16} className={cn("flex-none", t.text)} />
      <div className={cn("fg-body-sm min-w-0 flex-1", t.text)}>{children}</div>
      {action}
      {onDismiss ? <IconButton icon="x" size="sm" aria-label="Dismiss" onClick={onDismiss} /> : null}
    </div>
  );
}

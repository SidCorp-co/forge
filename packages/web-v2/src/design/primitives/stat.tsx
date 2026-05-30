import type { ReactNode } from "react";
import { Icon, type IconName } from "@/design/icons/icon";

export interface StatProps {
  icon?: IconName;
  children: ReactNode;
  /** Render the value in the mono face (default) — for metrics, IDs, money. */
  mono?: boolean;
  title?: string;
}

/** A small inline metric: `<Stat icon="dollar">$0.42</Stat>`. Lead with the
    number, label after (design system: numbers & telemetry are monospace). */
export function Stat({ icon, children, mono = true, title }: StatProps) {
  return (
    <span
      title={title}
      className="inline-flex items-center gap-[5px] text-subtle"
      style={{ fontSize: 12.5, fontFamily: mono ? "var(--font-mono)" : "var(--font-sans)" }}
    >
      {icon && <Icon name={icon} size={14} style={{ color: "var(--fg-subtle)" }} />}
      {children}
    </span>
  );
}

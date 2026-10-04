"use client";

// Who did or owns something, drawn one way everywhere: a person's initial in a round mark, an
// agent's mark in a violet square (never mistaken for a person's or a run's), and the name beside.

import { cn } from "@/lib/utils/cn";
import { Icon, type IconName } from "../icons/icon";
import { AGENT_TINT } from "../status";
import { LEGEND } from "../vocabulary";

export type WhoKind = "you" | "person" | "agent" | "system" | "issue" | "release" | "project";

const SYSTEM_ICON: Partial<Record<WhoKind, IconName>> = { system: "settings", issue: "rows", release: "rocket", project: "ecosystem" };

/** The small mark in front of a name: an initial for a person, an icon for an agent or the system. */
export function WhoMark({ kind, who, size = 16 }: { kind: WhoKind; who: string; size?: number }) {
  const base = "inline-grid flex-none place-items-center font-bold not-italic leading-none";
  const style = { width: size, height: size, fontSize: Math.round(size * 0.57) };
  if (kind === "you" || kind === "person") {
    return (
      <span
        aria-hidden
        className={cn(base, "rounded-full", kind === "you" ? "text-on-accent" : "bg-[var(--ink-600)] text-surface")}
        style={kind === "you" ? { ...style, background: LEGEND.you.dot } : style}
      >
        {(who.trim().charAt(0) || "?").toUpperCase()}
      </span>
    );
  }
  if (kind === "agent") {
    return (
      <span aria-hidden className={cn(base, "rounded-[4px]")} style={{ ...style, background: AGENT_TINT.bg, color: AGENT_TINT.fg }}>
        <Icon name="agent" size={Math.round(size * 0.7)} />
      </span>
    );
  }
  return (
    <span aria-hidden className={cn(base, "rounded-[4px]")} style={{ ...style, background: LEGEND.blocked.bg, color: LEGEND.blocked.fg }}>
      <Icon name={SYSTEM_ICON[kind] ?? "settings"} size={Math.round(size * 0.7)} />
    </span>
  );
}

export interface PersonChipProps {
  name: string;
  size?: number;
  /** The viewer themself: their mark wears the "waiting on you" amber. */
  you?: boolean;
  className?: string;
}

/** A person, by name; never by email. */
export function PersonChip({ name, size = 18, you, className }: PersonChipProps) {
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-1.5", className)} title={name} data-testid="person-chip">
      <WhoMark kind={you ? "you" : "person"} who={name} size={size} />
      <span className="truncate">{name}</span>
    </span>
  );
}

/** An agent (the master, a BA assistant, a run), marked as one in its tooltip and its mark. */
export function AgentChip({ name, size = 18, className }: Omit<PersonChipProps, "you">) {
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-1.5", className)} title={`${name} · agent`} data-testid="agent-chip">
      <WhoMark kind="agent" who={name} size={size} />
      <span className="truncate">{name}</span>
    </span>
  );
}

/** A person or an agent by the kind core reported, so a caller never branches on it. */
export function ActorChip({ name, kind, size, className }: { name: string; kind: "human" | "agent"; size?: number; className?: string }) {
  return kind === "agent" ? <AgentChip name={name} size={size} className={className} /> : <PersonChip name={name} size={size} className={className} />;
}

"use client";


import { Icon, type IconName } from "@/design";
import { DIRECTORY_STATUS_META, type DirectoryStatus, deriveDirectoryStatus } from "../derive";
import type { BindingRole, StatusCard } from "../types";
/** A deploy binding reads as the project-document environment that names it, where one does. */
export function scopeLabel(role: BindingRole, environment?: string | null): string {
  if (role === "service") return "Service";
  if (role === "source") return "Source";
  return environment ?? "Deploy";
}

/** The bare icon + text + tinted pill; feed it any `{icon,label,fg,bg}` meta. */
export function Pill({ icon, label, fg, bg }: { icon: IconName; label: string; fg: string; bg: string }) {
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-pill px-2 py-0.5 text-12 font-semibold"
      style={{ color: fg, background: bg }}
    >
      <Icon name={icon} size={13} />
      {label}
    </span>
  );
}

export function DirectoryStatusPill({ status }: { status: DirectoryStatus }) {
  return <Pill {...DIRECTORY_STATUS_META[status]} />;
}

/** Pill for a composed status card (directory state derived from the card). */
export function StatusPill({ card }: { card: StatusCard }) {
  return <DirectoryStatusPill status={deriveDirectoryStatus(card)} />;
}

"use client";

// Shared pill primitive + role/stage labels for the integrations feature (ISS-429) — one rendering
// of the icon + text + tinted pill (never color-only — a11y) instead of per-component copies.
//
// Provider labels and icons are NOT here: they live on each provider's own module and are read
// through `providers/registry.ts`. The two maps this file used to carry were one of the seven
// copies ISS-1071 collapsed.

import { Icon, type IconName } from "@/design";
import { DIRECTORY_STATUS_META, type DirectoryStatus, deriveDirectoryStatus } from "../derive";
import type { BindingRole, DeployStage, StatusCard } from "../types";

export const STAGE_LABEL: Record<string, string> = { preview: "Preview", live: "Live" };

export const STAGE_OPTIONS: { value: DeployStage; label: string; hint: string }[] = [
  { value: "preview", label: "Preview", hint: "where a change is seen before it ships" },
  { value: "live", label: "Live", hint: "where the people using this product are" },
];

export const ROLE_OPTIONS: { value: BindingRole; label: string; hint: string }[] = [
  { value: "deploy", label: "Deploy target", hint: "somewhere Forge deploys this project to" },
  {
    value: "service",
    label: "Service",
    hint: "a project-wide facility — an error tracker, a chat room, a repo host",
  },
];

/**
 * What a binding's scope reads as in a list. A service binding serves no stage,
 * so it says so rather than printing an empty set; a deploy binding names the
 * stages it actually serves, which is the thing the old `[prod]` on every sentry
 * and github row could not say.
 */
export function scopeLabel(role: BindingRole, stages: DeployStage[]): string {
  if (role === "service") return "Service";
  return stages.length > 0 ? stages.map((s) => STAGE_LABEL[s] ?? s).join(" + ") : "Deploy";
}

/** The bare icon + text + tinted pill; feed it any `{icon,label,fg,bg}` meta. */
export function Pill({ icon, label, fg, bg }: { icon: IconName; label: string; fg: string; bg: string }) {
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-pill px-2 py-0.5 text-[12px] font-semibold"
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

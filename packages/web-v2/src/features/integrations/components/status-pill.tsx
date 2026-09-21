"use client";


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

export function scopeLabel(role: BindingRole, stages: DeployStage[]): string {
  if (role === "service") return "Service";
  return stages.length > 0 ? stages.map((s) => STAGE_LABEL[s] ?? s).join(" + ") : "Deploy";
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

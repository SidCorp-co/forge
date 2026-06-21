"use client";

// Shared pill primitive + env/provider labels for the integrations feature
// (ISS-429) — one rendering of the icon + text + tinted pill (never
// color-only — a11y) instead of per-component copies.

import { Icon, type IconName } from "@/design";
import { DIRECTORY_STATUS_META, type DirectoryStatus, deriveDirectoryStatus } from "../derive";
import type { IntegrationEnvironment, StatusCard } from "../types";

export const ENV_LABEL: Record<string, string> = { staging: "Staging", prod: "Production" };

export const ENV_OPTIONS: { value: IntegrationEnvironment; label: string }[] = [
  { value: "staging", label: "Staging" },
  { value: "prod", label: "Production" },
];

export const PROVIDER_LABEL: Record<string, string> = {
  coolify: "Coolify deploy",
  postman: "Postman",
  epodsystem: "Epodsystem",
  sentry: "Sentry",
};

/** One provider→icon map for every integrations surface (card, drawers, panel). */
export const PROVIDER_ICON: Record<string, IconName> = {
  coolify: "server",
  postman: "command",
  epodsystem: "command",
  sentry: "shield",
};

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

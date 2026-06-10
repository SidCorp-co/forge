"use client";

// Shared status pill + env labels for the integrations feature (ISS-429) —
// one rendering of the icon + text + tinted pill (never color-only — a11y)
// instead of per-component copies.

import { Icon } from "@/design";
import { DIRECTORY_STATUS_META, type DirectoryStatus, deriveDirectoryStatus } from "../derive";
import type { StatusCard } from "../types";

export const ENV_LABEL: Record<string, string> = { staging: "Staging", prod: "Production" };

export function DirectoryStatusPill({ status }: { status: DirectoryStatus }) {
  const m = DIRECTORY_STATUS_META[status];
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-pill px-2 py-0.5 text-[12px] font-semibold"
      style={{ color: m.fg, background: m.bg }}
    >
      <Icon name={m.icon} size={13} />
      {m.label}
    </span>
  );
}

/** Pill for a composed status card (directory state derived from the card). */
export function StatusPill({ card }: { card: StatusCard }) {
  return <DirectoryStatusPill status={deriveDirectoryStatus(card)} />;
}

"use client";

import { HealthDot, IconButton, Kicker, Menu, Tooltip } from "@/design";
import { OPERATOR_SECTIONS } from "../nav-model";
import type { OperatorSectionKey } from "../types";

const STATUS_PILLS = ["db", "queue", "ws"] as const;

// cm:why the pill is focusable so its Tooltip is keyboard-reachable (Tooltip opens on focus), and the sr-only line repeats the note because a CSS tooltip is never announced
function StatusPill({ pill }: { pill: string }) {
  const note = `${pill.toUpperCase()} health checks aren't wired up yet`;
  return (
    <Tooltip label={note}>
      <span
        tabIndex={0}
        className="inline-flex items-center gap-1.5 rounded-pill border border-line px-2 py-1 focus-visible:shadow-[var(--shadow-focus)] focus-visible:outline-none"
      >
        <span className="fg-overline">{pill}</span>
        <HealthDot health="idle" />
        <span className="sr-only">{note}</span>
      </span>
    </Tooltip>
  );
}

// cm:why the NavRail account chip is desktop-only, so below md this menu is the only exit from /admin
function AccountMenu({ onAccount, onSignOut }: { onAccount: () => void; onSignOut: () => void }) {
  return (
    <Menu
      className="md:hidden"
      items={[
        { label: "Account & Settings", icon: "settings", onSelect: onAccount },
        { label: "Sign out", icon: "logOut", danger: true, onSelect: onSignOut },
      ]}
      trigger={<IconButton icon="more" size="sm" aria-label="Account menu" />}
    />
  );
}

/** Operator-owned header — `@/design` TopBar bakes an unconditional "New
 *  issue" CTA with no slot for these health pills, so this console gets its
 *  own header built from primitives instead (ISS-650 plan decision 5). */
export function OperatorTopbar({
  section,
  onAccount,
  onSignOut,
}: {
  section: OperatorSectionKey;
  onAccount: () => void;
  onSignOut: () => void;
}) {
  const label = OPERATOR_SECTIONS.find((s) => s.key === section)?.label ?? "Overview";
  return (
    <header className="flex h-14 flex-none items-center gap-3 border-b border-line bg-surface px-5">
      <Kicker>Operator</Kicker>
      <span className="fg-h3">{label}</span>
      <div className="ml-auto flex items-center gap-2">
        <div className="hidden items-center gap-2 sm:flex">
          {STATUS_PILLS.map((key) => (
            <StatusPill key={key} pill={key} />
          ))}
        </div>
        <AccountMenu onAccount={onAccount} onSignOut={onSignOut} />
      </div>
    </header>
  );
}

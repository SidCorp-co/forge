"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { HealthDot, Icon, Spinner } from "@/design";
import { useProjectRunners } from "@/features/runners/hooks";
import { runnerHealth, type ProjectRunner } from "@/features/runners/types";

const PLATFORM_LABEL: Record<string, string> = {
  macos: "macOS",
  linux: "Linux",
  windows: "Windows",
};

// cm:edge contract -> packages/core/src/lib/device-pool.ts#findChatCapableDeviceForProject — pickability must key off runnerStatus, since deviceStatus is stale for a live CLI runner (ISS-426 class)
function isSelectable(r: ProjectRunner): boolean {
  return !!r.deviceId && r.runnerStatus === "online" && !r.deviceDisabledAt;
}

// cm:edge contract -> packages/core/src/lib/device-pool.ts#findChatCapableDeviceForProject — dot+note must key off the same signal as isSelectable, since deviceStatus is stale for a live CLI runner (ISS-426 class)
function runnerState(r: ProjectRunner): { health: Parameters<typeof HealthDot>[0]["health"]; note: string | null } {
  if (r.deviceDisabledAt) return { health: "attention", note: "off" };
  if (r.runnerStatus !== "online") return { health: runnerHealth(r.runnerStatus), note: r.runnerStatus };
  return { health: "healthy", note: null };
}

interface RunnerPickerProps {
  projectId: string;
  /** The runner the session is currently bound to (live from `session.deviceId`). */
  boundDeviceId: string | null;
  /** Draft-mode pick (no session yet) — undefined once a real session exists. */
  selectedDeviceId: string | undefined;
  onSelect: (deviceId: string | undefined, label: string) => void;
  /** Viewers: show the current runner but don't allow changing it. */
  readOnly?: boolean;
  /** A switch is in flight (`useSetSessionRunner` pending) — locks the picker + spins. */
  switching?: boolean;
  /** Plain-language note shown inside the dropdown (e.g. draft-mode "applies to your first message"). */
  pendingNote?: string | null;
  /** Non-null keeps the popover openable but disables every row with this reason (e.g. agent busy). */
  lockedReason?: string | null;
}

export function RunnerPicker({
  projectId,
  boundDeviceId,
  selectedDeviceId,
  onSelect,
  readOnly,
  switching,
  pendingNote,
  lockedReason,
}: RunnerPickerProps) {
  const runnersQ = useProjectRunners(projectId);
  const runners = (runnersQ.data ?? []).filter((r) => !!r.deviceId);

  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null);

  const effectiveId = selectedDeviceId ?? boundDeviceId ?? undefined;
  const effective = effectiveId ? runners.find((r) => r.deviceId === effectiveId) : undefined;
  const triggerLabel = effectiveId
    ? effective?.deviceName ?? effectiveId.slice(0, 8)
    : "Auto";
  const triggerHealth = effective ? runnerState(effective).health : undefined;
  const rowsDisabled = !!switching || !!lockedReason;

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Anchor the panel to the viewport under the trigger, clamped on-screen
  // (matches ConversationList's placement so it never spills at narrow widths).
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const wrap = wrapRef.current;
      if (!wrap) return;
      const r = wrap.getBoundingClientRect();
      const gutter = 12;
      const vw = window.innerWidth;
      const width = Math.min(300, vw - gutter * 2);
      let left = r.right - width;
      left = Math.min(Math.max(left, gutter), vw - gutter - width);
      setPos({ top: r.bottom + 6, left, width });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open]);

  const pick = (deviceId: string | undefined, label: string) => {
    if (rowsDisabled) return;
    onSelect(deviceId, label);
    setOpen(false);
  };

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        disabled={readOnly}
        onClick={() => !readOnly && setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-busy={switching}
        title="Runner handling this conversation"
        className="inline-flex h-8 max-w-[200px] items-center gap-1.5 rounded-md border border-line bg-surface px-2.5 text-[13px] text-fg transition-colors hover:bg-hover focus-visible:outline-none disabled:cursor-default disabled:opacity-70"
      >
        <Icon name="server" size={14} className="flex-none text-subtle" />
        <span className="truncate">{triggerLabel}</span>
        {triggerHealth && <HealthDot health={triggerHealth} />}
        {!readOnly && (switching ? <Spinner size={13} /> : <Icon name="chevronDown" size={13} className="flex-none text-subtle" />)}
      </button>

      {open && (
        <div
          role="menu"
          aria-label="Choose a runner"
          style={{ top: pos?.top, left: pos?.left, width: pos?.width, visibility: pos ? undefined : "hidden" }}
          className="forge-drop fixed z-50 overflow-hidden rounded-lg border border-line bg-surface p-1.5 shadow-lg"
        >
          <div className="px-2 pb-1 pt-1 text-[11px] font-medium uppercase tracking-wide text-subtle">
            Runner
          </div>
          {pendingNote && <div className="px-2 pb-1.5 text-[12px] text-subtle">{pendingNote}</div>}
          {lockedReason && <div className="px-2 pb-1.5 text-[12px] text-subtle">{lockedReason}</div>}

          <PickerRow
            label="Auto"
            sub="Freshest online runner"
            selected={effectiveId === undefined}
            disabled={rowsDisabled}
            onSelect={() => pick(undefined, "Auto")}
          />

          {runnersQ.isLoading && (
            <div className="fg-caption px-2 py-2 text-subtle">Loading runners…</div>
          )}
          {!runnersQ.isLoading && runners.length === 0 && (
            <div className="fg-caption px-2 py-2 text-subtle">No runners assigned to this project.</div>
          )}

          {runners.map((r) => {
            const { health, note } = runnerState(r);
            const selectable = isSelectable(r);
            const label = r.deviceName ?? r.deviceId!.slice(0, 8);
            return (
              <PickerRow
                key={r.runnerId}
                label={label}
                sub={[PLATFORM_LABEL[r.platform ?? ""] ?? r.platform ?? undefined, note ?? undefined]
                  .filter(Boolean)
                  .join(" · ") || undefined}
                health={health}
                selected={effectiveId === r.deviceId}
                disabled={!selectable || rowsDisabled}
                onSelect={() => pick(r.deviceId ?? undefined, label)}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

function PickerRow({
  label,
  sub,
  health,
  selected,
  disabled,
  onSelect,
}: {
  label: string;
  sub?: string;
  health?: Parameters<typeof HealthDot>[0]["health"];
  selected: boolean;
  disabled?: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={selected}
      disabled={disabled}
      onClick={onSelect}
      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-hover focus-visible:bg-hover focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
    >
      {health ? (
        <HealthDot health={health} />
      ) : (
        <Icon name="server" size={13} className="flex-none text-subtle" />
      )}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] text-fg">{label}</span>
        {sub && <span className="block truncate text-[11px] text-subtle">{sub}</span>}
      </span>
      {selected && <Icon name="check" size={14} className="flex-none text-accent-text" />}
    </button>
  );
}

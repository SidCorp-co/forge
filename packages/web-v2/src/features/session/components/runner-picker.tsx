"use client";

// Chat runner picker (header of ChatScreen). Shows which runner currently
// handles the conversation and lets the user pin a specific one.
//
//  - "which runner": the trigger resolves the EFFECTIVE device — the pending
//    pick if the user chose one, else the session's bound `deviceId` (live via
//    WS), else "Auto" (server picks the freshest online runner on send).
//  - "choose a runner": the dropdown lists the project's device-hosted
//    chat runners with a live health dot. Selecting one sets a pending override
//    that rides the NEXT send (`sessionApi.send({ deviceId })` → core re-pins +
//    migrates the conversation to that runner). Offline / disabled runners are
//    shown but not selectable (the server would 409). "Auto" clears the pick.
//
// Self-managing popover (own outside-click / Esc close), anchored under its
// trigger — mirrors the History switcher pattern in this feature.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { HealthDot, Icon } from "@/design";
import { useProjectRunners } from "@/features/runners/hooks";
import { deviceHealth, type ProjectRunner } from "@/features/runners/types";

const PLATFORM_LABEL: Record<string, string> = {
  macos: "macOS",
  linux: "Linux",
  windows: "Windows",
};

/** A runner is pickable for chat only when its device is online + enabled. */
function isSelectable(r: ProjectRunner): boolean {
  return !!r.deviceId && r.deviceStatus === "online" && !r.deviceDisabledAt;
}

/** Health + short label for a runner's device state (accounts for "turned off"). */
function runnerState(r: ProjectRunner): { health: Parameters<typeof HealthDot>[0]["health"]; note: string | null } {
  if (r.deviceDisabledAt) return { health: "attention", note: "off" };
  if (r.deviceStatus !== "online") return { health: "idle", note: "offline" };
  return { health: deviceHealth(r.deviceStatus), note: null };
}

interface RunnerPickerProps {
  projectId: string;
  /** The runner the session is currently bound to (live from `session.deviceId`). */
  boundDeviceId: string | null;
  /** Pending explicit pick — undefined = Auto / follow the binding. */
  selectedDeviceId: string | undefined;
  onSelect: (deviceId: string | undefined) => void;
  /** Viewers: show the current runner but don't allow changing it. */
  readOnly?: boolean;
}

export function RunnerPicker({
  projectId,
  boundDeviceId,
  selectedDeviceId,
  onSelect,
  readOnly,
}: RunnerPickerProps) {
  const runnersQ = useProjectRunners(projectId);
  const runners = (runnersQ.data ?? []).filter((r) => !!r.deviceId);

  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null);

  // Effective device = the pending pick, else the live binding. `pending` marks
  // a pick that differs from what's bound now (applies on the next message).
  const effectiveId = selectedDeviceId ?? boundDeviceId ?? undefined;
  const pending = selectedDeviceId !== undefined && selectedDeviceId !== boundDeviceId;
  const effective = effectiveId ? runners.find((r) => r.deviceId === effectiveId) : undefined;
  const triggerLabel = effectiveId
    ? effective?.deviceName ?? effectiveId.slice(0, 8)
    : "Auto";
  const triggerHealth = effective ? runnerState(effective).health : undefined;

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

  const pick = (deviceId: string | undefined) => {
    onSelect(deviceId);
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
        title={pending ? "Runner for the next message" : "Runner handling this conversation"}
        className="inline-flex h-8 max-w-[200px] items-center gap-1.5 rounded-md border border-line bg-surface px-2.5 text-[13px] text-fg transition-colors hover:bg-hover focus-visible:outline-none disabled:cursor-default disabled:opacity-70"
      >
        <Icon name="server" size={14} className="flex-none text-subtle" />
        <span className="truncate">{triggerLabel}</span>
        {triggerHealth && <HealthDot health={triggerHealth} />}
        {pending && <span className="flex-none text-[11px] text-subtle">· next</span>}
        {!readOnly && <Icon name="chevronDown" size={13} className="flex-none text-subtle" />}
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

          <PickerRow
            label="Auto"
            sub="Freshest online runner"
            selected={selectedDeviceId === undefined}
            onSelect={() => pick(undefined)}
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
            return (
              <PickerRow
                key={r.runnerId}
                label={r.deviceName ?? r.deviceId!.slice(0, 8)}
                sub={[PLATFORM_LABEL[r.platform ?? ""] ?? r.platform ?? undefined, note ?? undefined]
                  .filter(Boolean)
                  .join(" · ") || undefined}
                health={health}
                selected={selectedDeviceId === r.deviceId}
                disabled={!selectable}
                onSelect={() => pick(r.deviceId ?? undefined)}
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
